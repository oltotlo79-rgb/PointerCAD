/**
 * 族の部品の保存・読み(K0 の検査 (b) の io 側)と、既存の形のファイルを読んで書いたバイトの一致(K0 の検査 (c))。
 *
 * (c) は既存の全ての行(model の legacySourceFreeze.test.ts と同じ 726 件)を 1 つのアセンブリに置き、
 * 書き出したファイルの中の各部品の出どころの JSON の SHA-256 を、族の登録口を入れる前の現物から機械で作った独立の
 * 定数表 `FROZEN_SAVED_SOURCE_SHA256` と照らす(2026-11-14 に main 52fdcc32 の作業ツリーで作成。
 * docs/次の版の作業一覧.md の K-00)。文書全体の形(部品表の既定ほか)には触れず、出どころの保存のバイトだけを固定する。
 * 加えて、JSON と ZIP(.pcada)で読んで書き直したバイトが一致すること、代表の部品の .pcad の読み書きの一致を確かめる。
 */
import { createHash } from 'node:crypto';
import {
  addComponent, buildStandardPartFromSource, CHANNEL_TABLE, createAssemblyDocument, createComponentFor,
  createStandardPartSource, DEEP_GROOVE_BALL_BEARINGS, EQUAL_ANGLE_TABLE, H_BEAM_TABLE, HEX_BOLT_TABLE, HEX_NUT_TABLE,
  PAN_HEAD_SCREW_TABLE, PLAIN_WASHER_TABLE, resolveAssembly, SOCKET_HEAD_CAP_SCREW_TABLE, SPRING_WASHER_TABLE,
  STEEL_PRODUCTS, steelProductOptions, type AssemblyDocument, type StandardCatalogId, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { standardPartRejection } from '@pointercad/model/testing/io-operations';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { isRecord } from './guards.js';
import { readPcadaFile, readPcadFile, writePcadaFile, writePcadFile } from './pcadFile.js';

interface FreezeInput {
  readonly label: string;
  readonly catalog: StandardCatalogId;
  readonly size: string;
  readonly options: Readonly<Record<string, string>>;
}

const THREADS = ['coarse', 'fine'] as const;
const SAVE_OPTIONS = { savedAt: '2026-11-14T00:00:00.000Z' };
const UNKNOWN_FAMILY_MESSAGE = 'この部品の種類は、このアプリの版の部品の表にありません。アプリを新しい版にしてから開いてください。';

/** 凍結の表を作った時と同じ並べ方(model の legacySourceFreeze.test.ts と同じ)。 */
function legacyInputs(): readonly FreezeInput[] {
  const inputs: FreezeInput[] = [];
  const add = (catalog: StandardCatalogId, size: string, tag: string, options: Readonly<Record<string, string>>): void => {
    inputs.push({ label: `${catalog}|${size}|${tag}`, catalog, size, options });
  };
  for (const row of HEX_BOLT_TABLE) {
    for (const thread of THREADS) {
      add('hexBolt', row.size, `${row.dimensionSeries}/${thread}/30`,
        { length: '30', dimensionSeries: row.dimensionSeries, threadSeries: thread });
    }
    if (row.dimensionSeries === 'main') {
      add('hexBolt', row.size, 'main/coarse/130', { length: '130', dimensionSeries: 'main', threadSeries: 'coarse' });
    }
  }
  for (const row of HEX_NUT_TABLE) {
    for (const thread of THREADS) {
      add('hexNut', row.size, `${row.dimensionSeries}/${thread}`, { dimensionSeries: row.dimensionSeries, threadSeries: thread });
    }
  }
  for (const row of SOCKET_HEAD_CAP_SCREW_TABLE) {
    for (const thread of THREADS) add('socketHeadCapScrew', row.size, `${thread}/30`, { length: '30', threadSeries: thread });
  }
  for (const row of PAN_HEAD_SCREW_TABLE) {
    for (const thread of THREADS) add('panHeadScrew', row.size, `${thread}/30`, { length: '30', threadSeries: thread });
  }
  for (const row of PLAIN_WASHER_TABLE) add('plainWasher', row.size, 'default', {});
  for (const row of SPRING_WASHER_TABLE) add('springWasher', row.size, 'default', {});
  for (const row of DEEP_GROOVE_BALL_BEARINGS) add('deepGrooveBallBearing', row.size, 'default', {});
  for (const row of EQUAL_ANGLE_TABLE) add('equalAngle', row.size, 'unspecified/1000', { length: '1000' });
  for (const row of CHANNEL_TABLE) add('channel', row.size, 'unspecified/1000', { length: '1000' });
  for (const row of H_BEAM_TABLE) add('hBeam', row.size, 'unspecified/1000', { length: '1000' });
  for (const row of STEEL_PRODUCTS) {
    inputs.push({ label: `steel|${row.key}`, catalog: row.catalog, size: row.size, options: steelProductOptions(row) });
  }
  add('filletWeld', '2x3', 'straight', { length: '100' });
  add('filletWeld', '2x3', 'oblique', { length: '100', weldAngle: '60' });
  add('filletWeld', '2x3', 'cylinder', { length: '100', weldCylinderRadius: '50' });
  add('filletWeld', '2x3', 'innerCylinder', { length: '100', weldCylinderRadius: '50', weldCylinderSide: 'interior' });
  return inputs;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assemblyOf(sources: readonly StandardPartSource[], name: string): AssemblyDocument {
  let document = createAssemblyDocument(name);
  for (const source of sources) document = addComponent(document, createComponentFor(document, source));
  return document;
}

/** 書き出した JSON の文字から、各部品の出どころをファイルの鍵の並びのまま JSON に戻す。 */
function savedSourceTexts(text: string): readonly string[] {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.document) || !Array.isArray(parsed.document.components)) {
    throw new Error('Saved assembly lacks document.components');
  }
  return parsed.document.components.map((component: unknown) => {
    if (!isRecord(component)) throw new Error('Saved component is not an object');
    return JSON.stringify(component.source);
  });
}

/** JSON と ZIP の両方で開き直し、同じ文書になり、書き直したバイトが一致することを確かめて開いた文書を返す。 */
async function reopenBoth(document: AssemblyDocument): Promise<readonly AssemblyDocument[]> {
  const text = writeAssemblyDocument(document, SAVE_OPTIONS);
  const json = readAssemblyDocument(text);
  if (!json.ok) throw new Error(JSON.stringify(json.error));
  const bytes = await writePcadaFile(document, SAVE_OPTIONS);
  const zip = await readPcadaFile(bytes);
  if (!zip.ok) throw new Error(JSON.stringify(zip.error));
  for (const reopened of [json.document, zip.document]) {
    expect(reopened).toEqual(document);
    expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
    expect(await writePcadaFile(reopened, SAVE_OPTIONS)).toEqual(bytes);
  }
  return [json.document, zip.document];
}

const FROZEN_SAVED_SOURCE_SHA256: readonly (readonly [string, string])[] = [
  ['hexBolt|M3|main/coarse/30', '3b781fc36dec184d9886cc45dc5dd30353a33663780bcc053798e1e222cb2c63'],
  ['hexBolt|M3|main/fine/30', '910d6e1c9f6d2f5a193c2ff34fd4f20b951f7244e1cb2d177ee891c9870b0b4a'],
  ['hexBolt|M3|main/coarse/130', 'e2fde73fd7b62236f06ae9f06fa71f3dce731f30199bd9631df7c089ed22c33e'],
  ['hexBolt|M4|main/coarse/30', '79b116cb3a19ba8eaa00e79fa3ecf7aa59845c5403cc145245f3cd6d03643e83'],
  ['hexBolt|M4|main/fine/30', 'ffcfdf2f336b925f33c7c5f488067a9661a7d4b660501ab77badfc86e30e5a86'],
  ['hexBolt|M4|main/coarse/130', '3f6c493cf5ff243238855ce5f89434aca444df8b6e2a6236ae5953ae37e33b8d'],
  ['hexBolt|M5|main/coarse/30', '46c47ef506f1d917e2ada9bc60e563e27c2e2037b8958064c85de1e8925ed2b2'],
  ['hexBolt|M5|main/fine/30', 'db3c27f3c09eac55b81b693d67a2992663943a1db2e851c2f92dd2312bd48d60'],
  ['hexBolt|M5|main/coarse/130', '7d79bb5fcf8d2dd8e1d7aa026a1802781cc1f86baaf279818588e138dba71314'],
  ['hexBolt|M6|main/coarse/30', 'efa4c6591010e45b5661652ba9642efb4e7787f06949625fac85eeb53f6748ee'],
  ['hexBolt|M6|main/fine/30', '4b03d4aa57478cedd35a6f58b66f346afba4ddabcfe408ddf61db295b0c496d1'],
  ['hexBolt|M6|main/coarse/130', '673af70cfef281105f5dc7c672609b98de098d9e54d2b723fed9ddd43d1576a3'],
  ['hexBolt|M8|main/coarse/30', 'e04cbb09371f466d75d1483231dab3f945166bc2d9c0240a5a66b162c9207e27'],
  ['hexBolt|M8|main/fine/30', '1c75618ebc47bb587ef355ec79cffd4dbea7a64ffdef7e2ff79b27949d7a1d58'],
  ['hexBolt|M8|main/coarse/130', 'f9934db766d62c4e8e6669be25ac02a634d15f5bf1884cfaa84c82e25294c23b'],
  ['hexBolt|M10|main/coarse/30', '193be7c8d155a250d71054841808539ae29e4117319a44f33730bc5556b12f05'],
  ['hexBolt|M10|main/fine/30', '3d193de24be168fde68841470a78421f94d0fb54382c1026ae4006808deb79de'],
  ['hexBolt|M10|main/coarse/130', '5e8ecfa5fd94e43b5039ee9c820010100e427e3ca0870e2dcf344faa5a60fe34'],
  ['hexBolt|M12|main/coarse/30', 'f1054e6bc5e7dbca9e77cac7804c6419372cbe069f3453d8982cabd6c59c1f74'],
  ['hexBolt|M12|main/fine/30', '6c274ced47937f4182fb2d1ebf41f616ea238c4309ed98b006aabc8fdf8626d9'],
  ['hexBolt|M12|main/coarse/130', 'd262dd7337fe453ff4d58de8a112ffbf29ec3d80200c3600869fbf24891ea2ba'],
  ['hexBolt|M14|main/coarse/30', '12bdf268fc6ea5a535f5fdd61fdef059deb50026b92f1a5ebadb8cc4cdcdbd82'],
  ['hexBolt|M14|main/fine/30', '5a5066500e3002d8d5e01b7e973452461439df95df29ae6373c39102806ae22f'],
  ['hexBolt|M14|main/coarse/130', 'd1b2801b7fba962bcd564aaad5d54dcc349c2d931969b6c2e5268472dc5aa6fc'],
  ['hexBolt|M16|main/coarse/30', '026463535ada1791cb1439bf6d1a850ecfd385eb3c15210fab820ba7a67ba5a1'],
  ['hexBolt|M16|main/fine/30', '6d608cc57a590e4e6cce911686b4607cc3ff111407fdda448b5a5b6a510e0e31'],
  ['hexBolt|M16|main/coarse/130', '3eb2a9e8c060226c0c706dbe63e1def2179d952b04fb733057a63327ff125ae2'],
  ['hexBolt|M18|main/coarse/30', '8b9f10dacd6ee1b32792618cd120c33eaa2e2d58179ece5104443a6644a14f39'],
  ['hexBolt|M18|main/fine/30', 'ac7333711ee949b73ec630cedcac3d1fcc2c0837964f7e859dfc79b07af8b537'],
  ['hexBolt|M18|main/coarse/130', '0a8dec2f0e59bfc536729dffbb01bc757e513ca5ccb4f8c0297ae2c5eca150f7'],
  ['hexBolt|M20|main/coarse/30', 'ea3acd16f819f9ee8360045f5ab4412911c58c5594a5bf2830012425cd487166'],
  ['hexBolt|M20|main/fine/30', '0eca4bd0dda7951c976a1a67136f924bfbdaa4d926b9bc000f589cabf560fbb4'],
  ['hexBolt|M20|main/coarse/130', 'fdcd4c3073015eda5a051345911bd075744dc48099d39fb61744f4c817dd29d6'],
  ['hexBolt|M3|annexJA/coarse/30', '8b34cf5918a46eb50bb6895d4cedfc05bfe5d5047bd9779c012aa5dfa7a7bafd'],
  ['hexBolt|M3|annexJA/fine/30', '787dc6557028fbae72dfea2e1d7dfdb8d755ea683f711556b281b45a69a33353'],
  ['hexBolt|M4|annexJA/coarse/30', 'f353d62693d3ee3469ff6dc8e44a4e3ab770770badfd5db2b7a58ca8caf99f24'],
  ['hexBolt|M4|annexJA/fine/30', '1cd5e1499e317f7652880cd58ec5ad8478d867ec2a47bc1b73b1322dcc6452b3'],
  ['hexBolt|M5|annexJA/coarse/30', '3d52dd06c828c2463e90caec2eba65a4a4cc5a2ea0905803c6ae47ba18ef0044'],
  ['hexBolt|M5|annexJA/fine/30', 'ba16fd8a48eb7d3ca066b4f98fb1a963a5dd2c45e46e5b60cf673c98aeb1588b'],
  ['hexBolt|M6|annexJA/coarse/30', '316cee25c430e1fe178f44cf4aa399adb370769232bc3341dc07416a01cb08e6'],
  ['hexBolt|M6|annexJA/fine/30', '002c3a9c17734b0d691266a22e39e40e958c7bdbbbf2f8417b1c4774c9bc98ef'],
  ['hexBolt|M8|annexJA/coarse/30', '7279e0a568604df458f27f93ee2c98cc2dc11ca59527106f2ab33d9f0a2ad0a5'],
  ['hexBolt|M8|annexJA/fine/30', 'e4052a7aa412611126ec180f84760d1f78d33910d02c324ecadf79019c7cef3a'],
  ['hexBolt|M10|annexJA/coarse/30', '3833503d99ebaf687de845e20142bc2fb95b6ec2cfe552381a3656c33d3f90ab'],
  ['hexBolt|M10|annexJA/fine/30', 'da0e7f6c47cfd7b6d91464ad2c0c9f41f7cad092556273dfd341e62e1ddc1204'],
  ['hexBolt|M12|annexJA/coarse/30', '1aa0aab9039e64210b038d89ace985c4a0efe27a664451b83dda7fc53d3a2a4e'],
  ['hexBolt|M12|annexJA/fine/30', '33763e70bc1604186707ff154148d7c391cedd921f51518b2df701558aa3e1df'],
  ['hexBolt|M16|annexJA/coarse/30', '9d40f8cdb35ac3b8818341fa4662a651e5ec7d823f2747975c4d387897d7fc8c'],
  ['hexBolt|M16|annexJA/fine/30', '8b24aa00d30b60e42d26415e02f4a74a3206235e4795bbc3905ba4d43bdbe0c2'],
  ['hexBolt|M20|annexJA/coarse/30', '965255ee37f442be8dd23d0b356102f0272e4f63300268065ca954f2ecd23608'],
  ['hexBolt|M20|annexJA/fine/30', '9721fa407973416dbfa6da3d4851960015c34e8bbacafe8c3947d5038f5129a6'],
  ['hexNut|M3|main/coarse', 'f7b8a39f5edb8297a2c8eb4c1da61ca81d7cfc5d4104bce23ff3bb504d089a18'],
  ['hexNut|M3|main/fine', 'a6a09352ffff6179107a3b7bceff86b88970aab5b79de56ebe9d4bafcf43d123'],
  ['hexNut|M4|main/coarse', '5ddfb07a8d2841f59b957b1e57f32f9f733b6bdf20c4674030be0daec761121c'],
  ['hexNut|M4|main/fine', '2a64e0db1d37d35deb00a14ad743a5112c3582e7e6ed8ee00546795f866d5ee9'],
  ['hexNut|M5|main/coarse', '08d317b64f921d4a996e8180a96b968750e88d2522af39da85cfef4663c5a462'],
  ['hexNut|M5|main/fine', 'e916fe46039d277baaf93176b45e2881f8ae58669f2c8e51a31ba1c011fa3d89'],
  ['hexNut|M6|main/coarse', '482816193f8464d62c26b48bf191c6a17605966ef97d5ed8a95c41d3db10fac3'],
  ['hexNut|M6|main/fine', '0f17b39e7873070d1095e645f1d1482b3e9f4617c7a2e49e5e898868bef3e63a'],
  ['hexNut|M8|main/coarse', '281463dca19760f072fe6bbb227c938df85c45d7cb13f40726b783e99238bf98'],
  ['hexNut|M8|main/fine', '490490eb54518bc774700ecd5877d9f64c15fc00761209698e6790996375bc43'],
  ['hexNut|M10|main/coarse', '8586f480a794f4129fa4d9fdaf2abbcaba809f400ac51d754c1adfbd9e4d81f0'],
  ['hexNut|M10|main/fine', '198e287ccc27050fbc8fb67e776a32e1ae4d8b5f646592451bd1944afb3cd0df'],
  ['hexNut|M12|main/coarse', '9bcba42b1e670e9698fd62c643ba756a3a5587e1e82b3df3cd35fd8b17180ac4'],
  ['hexNut|M12|main/fine', '9dfd952e66763ac9dc5d76c7b89f5a157264dcd946baeb097690347909e31f0a'],
  ['hexNut|M14|main/coarse', 'c65b2abc12ae0a6d1e57e0239c2716717167313504068aa2335c943c4f6252c7'],
  ['hexNut|M14|main/fine', '3481a11a63c6aa9ef72ca064e212b9923ff1765d1b2195e7e325b2621e3a4058'],
  ['hexNut|M16|main/coarse', '3c2beb9e805882c1b99afec171ee5949289cfb3979c12798fd57f80b2875c87d'],
  ['hexNut|M16|main/fine', 'c6292f9de7667c7e44674d6dd15af0f8b89313f1a72654c0159c484446b81372'],
  ['hexNut|M18|main/coarse', 'fe1153f9f3de042aca371f53c7e999c5da0b56ae98bbba49b791ca42984e4fbe'],
  ['hexNut|M18|main/fine', 'ce97e2145f0feee21499ce1d9278defb9bcd267b1caba7369b2de720ec26cd18'],
  ['hexNut|M20|main/coarse', '6bcd81baa222c35fc89f85b09d777e65d716437c8af34d9953ef9c119de1a292'],
  ['hexNut|M20|main/fine', '9894a930c59a199041b85de74b15d91c83caae0feba46eb0dc450586379a4688'],
  ['hexNut|M6|annexJA/coarse', '741910715c40744abe31d90fa394720d1e3a4e966894b6344a52fd92e2e82322'],
  ['hexNut|M6|annexJA/fine', 'df1d12ce0f702035ea7c3b387fab9c62e1e7cdeccee376e3ad93f1ee36fb33d4'],
  ['hexNut|M8|annexJA/coarse', 'bc873edac3b79f9d9daa67e909a2ea04b22ee1b58334d0c52f1603965dcee841'],
  ['hexNut|M8|annexJA/fine', '54b6c3e782ea088af05b453b7bee2370405a843a24f0833ae444d7e4a206de0e'],
  ['hexNut|M10|annexJA/coarse', '0d691c57c4f55dffa81a0d3342644c411d0189d0c130899c2783c06ef36a9167'],
  ['hexNut|M10|annexJA/fine', '2464eaa97559d68cd475caf9209cd3fb4608183891bc8c7afb8f5e5f7bf27d41'],
  ['hexNut|M12|annexJA/coarse', 'c6554cde4b0581d73638c2af126dfb8ca9495ad81d18e8bca99579022124839c'],
  ['hexNut|M12|annexJA/fine', '2dc64cb8fbb0c7e9deb67fa37be61a0590534576d9834a9b279806a270e45294'],
  ['hexNut|M16|annexJA/coarse', '2d937a548e300ce814ffaabfb439eb650d3cef8e0c1a5721453fad3b76d12185'],
  ['hexNut|M16|annexJA/fine', '1c08c622605e74cb5184f1c5f64677ebd505ccf9ed8dfc1bae47d8a1d64986c7'],
  ['hexNut|M20|annexJA/coarse', 'f53dcd8c54f146cc5c927047d33f90617dfae41fd8cf1235c737562cd4959966'],
  ['hexNut|M20|annexJA/fine', '3ea33a20ddfa23a23cc008bade2794e00bff87b12e65da5d78f855101f7ecd96'],
  ['socketHeadCapScrew|M3|coarse/30', '50a8ab325e1d3c1c75b927e7c5122fe045ad6cef86ef6f849f61f84e63398884'],
  ['socketHeadCapScrew|M3|fine/30', 'bdf08a3846696a333f11cbb7e94a1dee06e538703ef485138ba8707f111634ce'],
  ['socketHeadCapScrew|M4|coarse/30', '0529231b6c8f5c577f16a98ae966afd9c216c4bb2942b593a23e1e953d62eed6'],
  ['socketHeadCapScrew|M4|fine/30', '313dc638fd015166d3fb9d9e28c0a088f0fcf603a90363eafdcf1a860adfb06b'],
  ['socketHeadCapScrew|M5|coarse/30', '3c1873b718b46467348c5f1d2701bb9ba0a27dcf87d2a649a77057741a8660db'],
  ['socketHeadCapScrew|M5|fine/30', '4a1eed2f369a0f016af4b8ac4e27b4f55c44a97b58276d20834b772fdab64032'],
  ['socketHeadCapScrew|M6|coarse/30', '713cf54d13713822c3f74c5e34d1e775ead693169683d9e7470ed4c60d1408b9'],
  ['socketHeadCapScrew|M6|fine/30', '12dbe84fa285f6a8e060fbe0ccfe7e4a328f6cb534ab75ca65eba1b47716dbdb'],
  ['socketHeadCapScrew|M8|coarse/30', '66858adb82718a352040af2f107c57e076f9a3c520f317250442f27c83ca3d23'],
  ['socketHeadCapScrew|M8|fine/30', '1b27581d61c6d0b99ddefaa32512690b2f99d77a4927939f2a02117bd0c6fbef'],
  ['socketHeadCapScrew|M10|coarse/30', '6bf62ddaf5873981770fca3d696d1c7e8b7a67336c4e3d8d0c28b6550f087e8c'],
  ['socketHeadCapScrew|M10|fine/30', 'da16c50b030197d6c05132be5e30c84f98a4ae07dd8ee1d5bbf8eca5191a796a'],
  ['socketHeadCapScrew|M12|coarse/30', 'cb906bbbb3aa5e9aa7370ab90acb3477744f9580d382039841f43826864fa2ec'],
  ['socketHeadCapScrew|M12|fine/30', '71508ad1278b4bf75e579938ccfd96fd4f5570f106fde626a41ef2696d0a2594'],
  ['socketHeadCapScrew|M14|coarse/30', '788df33ea6671bc454b082bc6a689df4722e33c323a3fc3189240379e275db7c'],
  ['socketHeadCapScrew|M14|fine/30', '4d0d3ce0b587af49b595b6290c0bb75730053cd57a2233fb8e81ce76703023e5'],
  ['socketHeadCapScrew|M16|coarse/30', 'c374e1c165bd98be4fb6f9ed2b043d105c2454a64849fe91730bf4edb769f2c9'],
  ['socketHeadCapScrew|M16|fine/30', 'ad2566e93369956c98f3c388a46196b91a555b8c5335c1d93d6259db25400d2c'],
  ['socketHeadCapScrew|M18|coarse/30', '2bcd6912ca1b15e91605d949e58f728150fa4628e362f78142c4c8851a1102b1'],
  ['socketHeadCapScrew|M18|fine/30', '497fa6dbde439f00e65ef21d8ac8a862594f2ec15421c3e30d23b75cc9360621'],
  ['socketHeadCapScrew|M20|coarse/30', '5411897982bc5df4ad3cafd1f17f96c241ea2277db3bf56f66f4900dd58eb3b7'],
  ['socketHeadCapScrew|M20|fine/30', 'e589cf4d19d557ebcc7b21d1c21fc72ee337951fe8dad58c3437742c22848888'],
  ['panHeadScrew|M3|coarse/30', '318f0d8ec35602828fa5ff1f720a4b2fbffb2ce96044597736ccef7f47f6a01f'],
  ['panHeadScrew|M3|fine/30', '4c0100b29456c181f993000b1607d97cee4a2d4f6e5297c33782b8befbd23fed'],
  ['panHeadScrew|M4|coarse/30', '38e785fc6e740a1f9eb31056090c583f9b33d673e69e60c0d86d676d6d51fdfa'],
  ['panHeadScrew|M4|fine/30', '041d5dead779eb27ff87833f4a9c6f2276b0f3cbf757d05c226f866751d98460'],
  ['panHeadScrew|M5|coarse/30', '80df7e82dd768579b968f2f2d475484d077ac89dcd42769a0f6c5c15bffc81ff'],
  ['panHeadScrew|M5|fine/30', '99bdf0af642f7a067d385160fcc3df022d2ec857cf26dcd55bc8d06b9b7995d7'],
  ['panHeadScrew|M6|coarse/30', 'de7d782cd98230bf620c946cdd238f16399ffe1c8b94d7292e9b763526eb8f00'],
  ['panHeadScrew|M6|fine/30', '0e04016f051a8433f9c304d866a9bd3d714972eb1c3d9725868ff468afebf1e8'],
  ['panHeadScrew|M8|coarse/30', '4183fc74aa24c52155ce2d558dde26656374dfd4e754544c7b16d2c1ce8cdba0'],
  ['panHeadScrew|M8|fine/30', '21fd13d873c6f098453234ebf8d92db165e14ee2f66cbdaf44eff66153dbf880'],
  ['plainWasher|M3|default', '942cf050a0b89fd7cb90127005c3124acf03b3ae0cc45d2dc35dcbb3dcdf5deb'],
  ['plainWasher|M4|default', '106b23d6c5e7c5d072db459236ae0237df5fa8c83c4cc48bfba07d88e9994333'],
  ['plainWasher|M5|default', '559dc382c80909f620c096919d4db6d70ded42e81176848cdcdba7f19ed14d7b'],
  ['plainWasher|M6|default', '1c0485a26a8a5de8e75dc923487dd945e509d7733a984de322c0f3633b31a529'],
  ['plainWasher|M8|default', 'd6736056cad1de881e6c8524a37c3e6ef40121a20d73cd384834d6c671278acf'],
  ['plainWasher|M10|default', '27df6bf2d88b21e48ee1fa7bdb5761d807a2ed4e50668ce3cd63c62ecb2fe92f'],
  ['plainWasher|M12|default', 'b441075bd527a135eb047d2c0aba5c8ab4ec2f503ee3f9578ffecd6d0c1e64f5'],
  ['plainWasher|M14|default', '8aadec32337fa20f4a46cf95f45469971e811e8ca42c2f1ed9338f2664fb7bbc'],
  ['plainWasher|M16|default', 'dad27d00cc27bfdfd0af0370856ec603f9f5dde0688bad6ef79827293f178ef5'],
  ['plainWasher|M18|default', 'fbc59a0976821b25092b71cca3e782492931302f897a1b789aa60646bbcf6bd9'],
  ['plainWasher|M20|default', 'a3db13e9134b57c195fda413b2a5478d3db573542c2bbe822e68886d7db1e05a'],
  ['springWasher|M3|default', 'fd26515d24c7c453fb5f0f15334edfbb20a69e97e3e64c378ac7a0c1b12c060a'],
  ['springWasher|M4|default', '1294a7a1dec252cb198eb87f5bfcd931d1f1413fb9ecb32c7e3f78afe801cebe'],
  ['springWasher|M5|default', '079fbb50bffc3c11dc69a696150394ba70f6d94367280890b5d8c915bcc4c6e2'],
  ['springWasher|M6|default', '9034211fb7afeca421b3cc159869544dda2c871a10c5ced0914ba15296041ed6'],
  ['springWasher|M8|default', '39d671f45d1ae1e3727b74a2228e1a92882b309dea9a1fe9cf2bdc2433164599'],
  ['springWasher|M10|default', '9fbef017eb24131b23a424dee093305b0d436d19083cf6bf83acf6ca18412dd2'],
  ['springWasher|M12|default', 'f49523310edec96df3b8d77f1d2084a2a6b04940e1fbca1e0f7fd241e3c626d2'],
  ['springWasher|M14|default', 'd7f573af65bd0b2b54e864282e6a7f979d425edfdaad8fa804ed7ffbb9e778ce'],
  ['springWasher|M16|default', '1c7c8bb99674e65cae89ad3ef368c206ae0ceb30927271760854e6c463f46b29'],
  ['springWasher|M18|default', '2b411d52c611144dc9c1b0a176876d20c59ec3a71ff1ce5ae67d3d66e1d5d7b7'],
  ['springWasher|M20|default', '6790b2270d11e8b0c89fcbea4321cb694599bdd20ada575b96a41cca7a207e09'],
  ['deepGrooveBallBearing|6000|default', '7a34c3b8ab937c84104c7e3b64885d5591f8dbf2d4cb7ae12414ef36f9380b18'],
  ['deepGrooveBallBearing|6004|default', '9394440243535537c33bf57be22e64262d28ba29f4b4e0d0d4444ebf2022d2e7'],
  ['deepGrooveBallBearing|6006|default', 'a1056ad809c4986d6b410cde7581935653c4ca10cf1d6dbaeb1bfc44ca518f45'],
  ['deepGrooveBallBearing|6008|default', 'e77e10fe81bc8e4aada99b731cd0824b33b8f42a11e5dd8f6af6e73cf6229286'],
  ['deepGrooveBallBearing|6010|default', '7dedab3d62eb6e29755e1bac4ceadf1d96a9d50d00814b6e05622e46d701b887'],
  ['deepGrooveBallBearing|6200|default', '8f41f515949146535cbcafd011bde1647030ff8dad34d9b24b9007e2ec9d5d3d'],
  ['deepGrooveBallBearing|6204|default', '998e01fc68cb898d43bcdc4983a75852c89fa5e45c83ef95d6d9f7e836eba1b0'],
  ['deepGrooveBallBearing|6206|default', 'eb66121b6140443f6073627fb3e45b3761682142445a0604f91e7177a1bbefc4'],
  ['deepGrooveBallBearing|6208|default', '35723f2932f82f784ddbf6fcc2d7fed5f112acb6124e9e79a90130c5d4c8dc96'],
  ['deepGrooveBallBearing|6210|default', 'baf915189906e31ce010a25b82a9efb905ecce9a5f96bdc4e43b342a487cbcac'],
  ['deepGrooveBallBearing|6300|default', '57ff3149c39a26c9f52d3e166060039d432fc0a6feb8bcc7ed6adedea4884c46'],
  ['deepGrooveBallBearing|6304|default', '8c64b01a1fd1f97e777fdcd9ed7bbacc36171a45fb694c65c35bb3962641d7a6'],
  ['deepGrooveBallBearing|6306|default', '4e0c82bdef83ca942ae93eb0f32a2ee99a2bb88d35007032766668a9f6b47c7c'],
  ['deepGrooveBallBearing|6308|default', '4e589018b1c64b0abb371576ff5f3be6f6563dcb2202bef665730b864382e26f'],
  ['deepGrooveBallBearing|6310|default', 'fa225b4f6ec440c6d7f8bc5f8f900b001fcb51b5cbbee5d1ee0264bb6efc1732'],
  ['equalAngle|L 25×25×3|unspecified/1000', '8049445e13e8228b42b01bacddf7d456cf3d81c374a22ace9fa43ad0b3f0437c'],
  ['equalAngle|L 30×30×3|unspecified/1000', 'd72f3e6676d97bfaee7ccf71ade721b45246e7b2d65f9a448849d9049dd5c4e4'],
  ['equalAngle|L 40×40×3|unspecified/1000', 'c792490f83bf2007f07429438172c47af69d3b54f728502a6f80308158cac843'],
  ['equalAngle|L 40×40×5|unspecified/1000', '65d4a80ecbf1d18e08bcb38be4b204741450353040df68629aa0585e9c988698'],
  ['equalAngle|L 45×45×4|unspecified/1000', 'a9c7b3aef375b8af6bbec46e35cd161a2b071984b43cae12e929b1bbf3e67c04'],
  ['equalAngle|L 45×45×5|unspecified/1000', 'ee7302e7dc4009dafd0474349a47daf3da5711fefbd72a089f6e67b2430f9744'],
  ['equalAngle|L 50×50×4|unspecified/1000', '1d65271b022f86c770b32353b700c1ec64f84fff5fad7e8e4fc8f5c2ce91de5c'],
  ['equalAngle|L 50×50×5|unspecified/1000', '689077856dd80523c69c376b157fe8bbe16fa1a1d2741594dcc6010a6d4c0164'],
  ['equalAngle|L 50×50×6|unspecified/1000', '54c6c0d47bfec7a9a161e58b5f1b2ad58bbe7977525a65f29ac12adaaf765b86'],
  ['equalAngle|L 60×60×4|unspecified/1000', '67dbea8708754ebf01ac33b4dbd6c748f1af51b60eb56a67e3d6f611707e4fc8'],
  ['equalAngle|L 60×60×5|unspecified/1000', 'bbc65f84b719f9ee464dce90702ad0bc727c1856d3e3fe8d04864943ef9419e9'],
  ['equalAngle|L 65×65×5|unspecified/1000', '0872a1b8f0d8a908f570057b3f875b0db3444f8c3c89d86f7b871d188e82a465'],
  ['equalAngle|L 65×65×6|unspecified/1000', '3401b667d6ae60e74ffe2cedaf117b3eb246f6e9e68e6fb94e6903962938d24b'],
  ['equalAngle|L 65×65×8|unspecified/1000', '05d734d95d49b08c57581eaca0b78d6ecb40d82f148813d5f6d2e6be68d40895'],
  ['equalAngle|L 70×70×6|unspecified/1000', 'b9bfccb9e776b6b276ff9d1bf597b515136e08d9c772701afb19ed7488f5da81'],
  ['equalAngle|L 75×75×6|unspecified/1000', '753c8184878b3366aaae48d94cef346394863a28bb7307d60085f253045b64a4'],
  ['equalAngle|L 75×75×9|unspecified/1000', 'cfc0e15d5d62d5e537eed3580dd615d5769a670f2d8423856e7f5d94d7790a3a'],
  ['equalAngle|L 75×75×12|unspecified/1000', '7d8c2d60db3b351509f67bcad78138d11d285befd7404c57e4596e18309ec184'],
  ['equalAngle|L 80×80×6|unspecified/1000', 'bc11d3ee5ad53b3fb1d3a69283050f271a48ea80e0e90efb4ed836d55bffc80f'],
  ['equalAngle|L 90×90×6|unspecified/1000', '6330e2cbbddda3dff50a751027c656cee060500a9ec2f4dc2d5ea55c26fd7384'],
  ['equalAngle|L 90×90×7|unspecified/1000', 'd61f044e96842b188899159f01bb28fa5e8f205ddfafda2ec845fd7e6a02a34e'],
  ['equalAngle|L 90×90×10|unspecified/1000', '74722064b45671c8135382acb1acd0c0057e8cd273e4656412b95110b2a1aec4'],
  ['equalAngle|L 90×90×13|unspecified/1000', '7474f13ec5386be64d98b9e19c3473c52a9e6bd4d236459669c46b82ccc8eb58'],
  ['equalAngle|L 100×100×7|unspecified/1000', 'f71090cda15a155c96f0b105a7b1d823d9e1615ee01d6b29bb5796d4c74e88c6'],
  ['equalAngle|L 100×100×10|unspecified/1000', '8a96f562d1998f7e1203dcdacccfce1d080790fe64f16f23fcff034e0129384a'],
  ['equalAngle|L 100×100×13|unspecified/1000', '229a8a3a8abaf14c5dfb6bb3cd49268c53fcd6adecc2bc76ee3831f9a5e48ada'],
  ['equalAngle|L 120×120×8|unspecified/1000', '27b0a73c3933601d2d7ee601319c0fa71c15a6e095736cb3ec22408461a475a8'],
  ['equalAngle|L 130×130×9|unspecified/1000', '2be893d248a605f3cb9452dc37bc4696357702e26e5dec11771e17e4e14ce80c'],
  ['equalAngle|L 130×130×12|unspecified/1000', 'f9f7add72aaefc3f8440332ccebcdba52a215d3fd7a62a17ce4bcc5209a9f613'],
  ['equalAngle|L 130×130×15|unspecified/1000', 'e1d4d0153dd843d3501b6312e14f38f6eb0fc0d8cdf6a744b4e0c812c28a0a49'],
  ['equalAngle|L 150×150×12|unspecified/1000', '89655385d6e057a7d67ea3e2ef2e8210195d5a465160fa66f2c5a93d9fffc2e8'],
  ['equalAngle|L 150×150×15|unspecified/1000', 'b127efb066e552cd1323e7699a14caf22ed653deb92ae665974fa81b282fcb16'],
  ['equalAngle|L 150×150×19|unspecified/1000', 'c5add9a0aee37e2529138cdcdedf7ff4899694caebc5daa4bb3f2286bfc2556e'],
  ['equalAngle|L 175×175×12|unspecified/1000', '469332714b1060a7545031c957afd5f2431a9462686e6c33058096e39acc01f4'],
  ['equalAngle|L 175×175×15|unspecified/1000', '0aa336cdd0f1682f0a06958ccba08dc4e6dcef0a76e1d8f65e79aad630f0bebd'],
  ['equalAngle|L 200×200×15|unspecified/1000', '40b2b515e70036f30927a6679ec0d67fb575ab8fa706bfebff170b830e846dee'],
  ['equalAngle|L 200×200×20|unspecified/1000', '0408a49748ad70c36181d93cec9124b058812de655af526f66dd231b9ec9168f'],
  ['equalAngle|L 200×200×25|unspecified/1000', '83c1f0338e6f045bc2b662fdb37bc6d6021dd068227e5e4d53b4230948e6b315'],
  ['equalAngle|L 250×250×25|unspecified/1000', '554956e9f5c964c955c2c14c99d4041317c665996818d15a37b540d012054b13'],
  ['equalAngle|L 250×250×35|unspecified/1000', 'cac0ddfdfea5e376f768277de5f2226de280fdea2966375995ea7bf1461d5157'],
  ['channel|[ 75×40×5×7|unspecified/1000', 'aa0cbcc32a4548ae08c95095797cf0d9a93953f0122be65e35db27ecf0e54441'],
  ['channel|[ 100×50×5×7.5|unspecified/1000', '5f5cff9014648f41f3f0eeea5becc3c4e574bcb30a1006269c177e27eaddfa71'],
  ['channel|[ 125×65×6×8|unspecified/1000', '8480892598620fea89035aae4e1dbe1d364f77c74b6543c275ef531dd83ab03d'],
  ['channel|[ 150×75×6.5×10|unspecified/1000', '69ed02738eb131e435d71b77ebca528bd6eb74ed59a677fb1aaa42acf34b7c01'],
  ['channel|[ 150×75×9×12.5|unspecified/1000', '4c31a67b8017a7f4f4b5e8126cb37577d4677b921df7c939116a7e08a1bb9766'],
  ['channel|[ 180×75×7×10.5|unspecified/1000', '9d0f98b8c2a409406f96bacafa9260ea68e30f81f8d2c8ed209cb7ed4854ca68'],
  ['channel|[ 200×80×7.5×11|unspecified/1000', 'b6d67c86274a484f71063c2dd70dce5eb6adbaabee64729cff1ddf0ce1deb884'],
  ['channel|[ 200×90×8×13.5|unspecified/1000', '32400a0db578040785d0d3f04677bc198e0da394b5b4badc3d5e0dcbbfb4bd1e'],
  ['channel|[ 250×90×9×13|unspecified/1000', '12b726436941d41d71b69d2525529f07e9765d071f3b3b233fb78a53230b52c3'],
  ['channel|[ 250×90×11×14.5|unspecified/1000', '802ef5de045660db3cd624981682a719ab7d9396b217b0fc3f94e7942c6f5d91'],
  ['channel|[ 300×90×9×13|unspecified/1000', '0c1e8d720ebb5f4b8f035eabbf595fac00864eb95a722ef0a7330a2d68aa0f58'],
  ['channel|[ 300×90×10×15.5|unspecified/1000', '5bb7a4f33e1ef3aec7c40411fd65af3f26c7bda454bd0a108485c7a4774f29fa'],
  ['channel|[ 300×90×12×16|unspecified/1000', '8517b6ca3090baa6502421644cbc6883cfacfd032b71ae94264beaa8eea59e44'],
  ['channel|[ 380×100×10.5×16|unspecified/1000', '2826cff10af38b8c62a84a4482aa2bb9cf6cf7e316165a32f7abca2b1c4ce435'],
  ['channel|[ 380×100×13×16.5|unspecified/1000', '7f377166cab59935e4e4609e5b352f4d3340801f294a28b517fd7fa1275844c9'],
  ['channel|[ 380×100×13×20|unspecified/1000', 'a431de9b49b43fe085f63bdeada486af849557fdd1ee9ac45e377307136afa2d'],
  ['hBeam|H 100×100×6×8|unspecified/1000', '44ad7c5ceb960ea19d254497da71785ad132fbd87bdfab7fc79f597a67a853d0'],
  ['hBeam|H 125×125×6.5×9|unspecified/1000', 'c010fe25291408bf7436d31b5c3ea154465ec45507fa48ee7a0b250249034b06'],
  ['hBeam|H 150×150×7×10|unspecified/1000', '0b8f166c36402de70aaebf842d74d3877d8c4b808109778cbc0a495dbdc4fddd'],
  ['hBeam|H 175×175×7.5×11|unspecified/1000', 'ca31c3a7803ce85799e16850b1d608f036952d1d8c483d621714d29af1d6f8fe'],
  ['hBeam|H 200×200×8×12|unspecified/1000', 'ff1d95e4ed4c66e0c59294772d3b7b54062eb2a909e5d7f3c1acf7c50f6e88ca'],
  ['hBeam|H 250×250×9×14|unspecified/1000', 'a17fb42af87690bf993bb66caeeefe08cb7f60de44878cfdb15609c97a3b511a'],
  ['hBeam|H 300×300×10×15|unspecified/1000', 'd6483f36c8f1c109d7724ba487de3e075daaaa4352237c547a7f179fe9c7e3be'],
  ['hBeam|H 100×50×5×7|unspecified/1000', '5cd2710eb113bfd2c97f29af8527107e7ab12e9e9b1af849e0ac38097cf555d5'],
  ['hBeam|H 125×60×6×8|unspecified/1000', '3a2d8948875b575b09c18b4e178b15824c0bb41a3a048f0bb9874acaae1f3e5b'],
  ['hBeam|H 150×75×5×7|unspecified/1000', '849b4433c88bfa5e2b4e6d3ab9f08100bf557fb76eb22b37e9e21fba2ea32e73'],
  ['hBeam|H 148×100×6×9|unspecified/1000', '7dbab8d3ecb5be6e9ce33638ec518ea3e8baed7dbc3cb6d47e76bd8e4be13c8e'],
  ['hBeam|H 175×90×5×8|unspecified/1000', 'a602230e673c5b4469424800896d39529c08aca5c3c380dd700679235656f000'],
  ['hBeam|H 198×99×4.5×7|unspecified/1000', '706f9a4488b70f450c0b695c6d10be7de5208bee90ee51f788185e52c87b0d18'],
  ['hBeam|H 200×100×5.5×8|unspecified/1000', '0408e3f333abc92a49e75968a1520a41856530ebefb6d6df6070208fa4960bd1'],
  ['hBeam|H 194×150×6×9|unspecified/1000', '0a074098667d5b43c2506d416e17cf37f283a2b59a33dd4b122c6f353d34c7f5'],
  ['hBeam|H 248×124×5×8|unspecified/1000', '9be928156822fb51b38220c67cbd46ea536558245e5790e38aab72b765061d4c'],
  ['hBeam|H 250×125×6×9|unspecified/1000', '1fb41796fad682f32a11a5d3f8e50061325f8823cd163a860d7b28f6f44a1c91'],
  ['hBeam|H 244×175×7×11|unspecified/1000', '3ed8f442b7f1c08a2dcd5ee4482e86fa64862dd4ef138e23f9102d5bdd99ef8e'],
  ['hBeam|H 298×149×5.5×8|unspecified/1000', '8ffe87509ce96918049e31334d8850645994e335b0ba7c13186f643d00f3b948'],
  ['hBeam|H 300×150×6.5×9|unspecified/1000', 'b4b108cf15c66dd27b8e40900d27ccdd5e59eae297ded15dbdf131c8caffbe0c'],
  ['hBeam|H 294×200×8×12|unspecified/1000', '91648ca9b83c63abd24925dbd647ad2117f7f1c0f30a81254f3c679896263c8d'],
  ['hBeam|H 346×174×6×9|unspecified/1000', 'f11fd0222ca58200db8f4a3b2186eee8e7b845bfec958034f9994202122c01eb'],
  ['hBeam|H 350×175×7×11|unspecified/1000', '96f6db88e16a6e9749a8cf863463ebdf4ec63759904bfdbdcde726a6aaade13f'],
  ['hBeam|H 340×250×9×14|unspecified/1000', '1a4409f26e475514a3ea1d06d7d06577b14b9e4e49e202295c2f85e0a90aa339'],
  ['hBeam|H 350×350×12×19|unspecified/1000', 'eb1dfb51a6fe3e6ee841371603c141fe49f0d0974ec362de8fd10a3732477f97'],
  ['hBeam|H 396×199×7×11|unspecified/1000', '3ca8e5a1d85aff454c1fbfd225d2a4070de7cdd915046f69f44e9f6b0d78a580'],
  ['hBeam|H 400×200×8×13|unspecified/1000', '4a188ab6536ff813f6aa4ebe810961ebfa68f8637c9c4ca56bdf85438b5756d6'],
  ['hBeam|H 390×300×10×16|unspecified/1000', '0b43ae67a3dd79a66d03d912e28e11c66efa39ceff056130b0675efb9ded0936'],
  ['hBeam|H 400×400×13×21|unspecified/1000', '0c01276b89a9adaaa1cf0b1377cc82ef23e1a0e444a3b8b255d79e8ea7e47403'],
  ['hBeam|H 414×405×18×28|unspecified/1000', '11b5548efd3f8d0758cb2668db523f5a6902a13ae77ad281cfdbd117ba51f71c'],
  ['hBeam|H 428×407×20×35|unspecified/1000', 'ab45a428c7b3e4e862c2ea3676f6d5757e19d67cb2612534b0e3d640df2efcc2'],
  ['hBeam|H 458×417×30×50|unspecified/1000', 'd2b933c6e260e17085b1057f7c29f1fc7145cbab5c7d62e7987a4ff9fa52a496'],
  ['hBeam|H 498×432×45×70|unspecified/1000', 'afed1888144e4bd88d98378b0e74c19e38eb7a6baa4656665b16c29d570be379'],
  ['hBeam|H 446×199×8×12|unspecified/1000', '486ec1a1ecb634e72748a3b26189bb30ba2ef6c8f8e993608a3290462a23b0d5'],
  ['hBeam|H 450×200×9×14|unspecified/1000', '490074a11ecbce89f400685340e89dbee39fb9c4a26c745292e7819c5e401965'],
  ['hBeam|H 440×300×11×18|unspecified/1000', '3d978ebd847db3694a6d836537a47fba29ff050e9a866eed8aa49227b81e5431'],
  ['hBeam|H 496×199×9×14|unspecified/1000', 'd5a271e28293b071d5422bd5a0d8a64c215c3fda5dff6dbd519bc728759f109d'],
  ['hBeam|H 500×200×10×16|unspecified/1000', 'b156a70156c3619340ec283884dc9b02055c2fa27aab2d9123e579deee97f3fb'],
  ['hBeam|H 482×300×11×15|unspecified/1000', 'e33fb089e67a2daf2b51562aa63c3f53c4c43c3fd70b4724e719f931fc3c3cea'],
  ['hBeam|H 488×300×11×18|unspecified/1000', '8a48cedce071600fb1631587ab25b248f3171c7a341efef3e50f2f6c2c765c46'],
  ['hBeam|H 596×199×10×15|unspecified/1000', '2a76680c75c483c6598894b4cbff9ec7ef4a4569e73f1ee689ae6f532a727788'],
  ['hBeam|H 600×200×11×17|unspecified/1000', '73a71415d0c6f39d2cbbafcc670bf744412b21b21f43a04327fafa2d2c27591c'],
  ['hBeam|H 582×300×12×17|unspecified/1000', 'fff80c5e177fd77f1381a14c11a0886473a7843fe66d64c30d00ba088e3a3947'],
  ['hBeam|H 588×300×12×20|unspecified/1000', '0f0ba669e489b1ed047a76e841943c82cf840fec24050ea99154a7dbfbf71e6b'],
  ['hBeam|H 594×302×14×23|unspecified/1000', '003f20ef4f833a6663641b4397a5bbfdd7137919214d16de17916ebf4176ec09'],
  ['hBeam|H 692×300×13×20|unspecified/1000', 'a64b312770f3a67cddfffde5b4778d3e729ba6e1e48c0542c30e6c572da55400'],
  ['hBeam|H 700×300×13×24|unspecified/1000', 'd7c96f975abc66a4f74c4ff62b96322f24efb82c8a80d60c87c686f38c70cb1c'],
  ['hBeam|H 792×300×14×22|unspecified/1000', '27086119bae2c6288f69a8d997292f63683d523b91d9c276a49d708b0bc8f6da'],
  ['hBeam|H 800×300×14×26|unspecified/1000', '6f11991e19df51650cabb52e5b409bb4ff4646e020ac62d9a562fb2fa2ba6da9'],
  ['hBeam|H 890×299×15×23|unspecified/1000', '855e1920833aeb65581860ba6b37b605cc6b837d068e7d39f74ca37703208ce0'],
  ['hBeam|H 900×300×16×28|unspecified/1000', 'a79e0df3415848f7f67599d1bf90650f0507a75e696dc5d1dae5d48324ce3ca3'],
  ['hBeam|H 912×302×18×34|unspecified/1000', '96c05948c4215c6206dbec7151cadaf349c5d9884f417fcbdd256771eb57ae6b'],
  ['hBeam|H 918×303×19×37|unspecified/1000', 'cb1ddd3c07dafb34677aaf2eb00b5a06379b9007202b99ba5a14bd273e31a5c3'],
  ['steel|SS400:flatBar:FB 50×6', '9bb036a675391ff86a117894f845ec2af44e1c8a7338f42221fac8cbdf16f855'],
  ['steel|SS400:flatBar:FB 50×9', 'fd80b5031891407b66caea36cac2de2f1b5639b563170043e45d56995dc36f9c'],
  ['steel|SS400:flatBar:FB 50×12', '629c0dd5982ea124e12803d3d8d32b361f9a5c5d73d3237392443b42fdaf9a97'],
  ['steel|SS400:flatBar:FB 100×6', '01e77d1909c6515784db4dc2ed0966bb2777f4ab821e8c758c0fd1c8ea272458'],
  ['steel|SS400:flatBar:FB 100×9', 'fef009643a2359fcdc48a272838df0dff95abbafa757f6830625c03299597f43'],
  ['steel|SS400:roundBar:φ13', '21047fe9065796fd2625adb06fede0d1a429d5dce8f1cad3c50b014d23827405'],
  ['steel|SS400:roundBar:φ16', '53598cb787131b24f2acc2bcb9d462c330cc26700f48e68927a47d1021c228e0'],
  ['steel|SS400:roundBar:φ19', '62d2e2e5831e75d6724a256ce3de588c553501d128448cfe25ed05f7a141bdb2'],
  ['steel|SS400:roundBar:φ22', '037a36de5d2a95283753406856c18dd170f23c3bc2c984dc49613296d8b577b7'],
  ['steel|SS400:roundBar:φ25', '952198467fb16ddf7a1a0a16efa05061af22dff7bd0b8d8f22dd2b99d4923528'],
  ['steel|SS400:equalAngle:L 40×40×5', '8fa5beda2ebc4c4c8399df7f0f0b3c7573684241cf4a1acae4b38f00aa07a334'],
  ['steel|SS400:equalAngle:L 50×50×6', 'fffb60fe8fc562b24a466346c5133825a2b9d646d6274e234e057fe1014fe81f'],
  ['steel|SS400:equalAngle:L 65×65×6', 'cb32fcdf7f2f9a77ca4efd16cdc99f84bef8a7df1620d6dba3d73b9cc1d12fc9'],
  ['steel|SS400:channel:[ 75×40×5×7', 'aca6dde19bd31305f1022495e32e29f51706a0f20ac18b79b91851fb91d7e1e4'],
  ['steel|SS400:channel:[ 100×50×5×7.5', 'ca0d42c57c6df097e07ab565ab04cc588a5ce96527dd0e36357b2ba568ef39cd'],
  ['steel|SS400:channel:[ 125×65×6×8', '79bd464a6400f972b1c25bc082ccf9d018f41e5fe39ecae67b8beca3772d6a8f'],
  ['steel|SS400:hBeam:H 150×150×7×10', 'ae3e9ffc11d203ebbb9765c7b74af652bfc0c9aaaf3249fba70ce5e70372319f'],
  ['steel|SS400:hBeam:H 200×200×8×12', '2add5bcf392849c2a0afd9c6fdbdeed8f7fdb2ba25e0c4aca44e65eb12733020'],
  ['steel|SS400:hBeam:H 300×300×10×15', '742add742b439ecbdf92a0694a0898a25c0a4c7178f2f384559f29d8fe51c738'],
  ['steel|S45C:roundBar:φ20', '690d2de6ea08bd502de2608d7556f6eb41004d40e9e429cd43f85aae2d9cdc7c'],
  ['steel|S45C:roundBar:φ25', '1572e34073b2c238cb0727051a87ba70c9b48325bb46af82e490613f633474ba'],
  ['steel|S45C:roundBar:φ30', '220bcd3416782b44e420109d803b26eae5b759e2ac23c30061201ea10bb0aac3'],
  ['steel|S45C:flatBar:FB 50×6', '394a0cbed87de90d9c551abc52e0aa162455b758c51a0ee46051913baf7592cd'],
  ['steel|S45C:flatBar:FB 50×9', '880b6b7d81a2e378675fc53c0670f517557fd74234d7f23b8f3ffe5515ad0e99'],
  ['steel|S45C:flatBar:FB 50×12', '9e129570520a0fca4434112d911c36567c1394385eafa51b798c1f85ebd227b4'],
  ['steel|SGP:steelPipe:15A', '91d50201d91d83fc9eee4377992b1199707f14a4e3eacd61763b476082ee5a2c'],
  ['steel|SGP:steelPipe:20A', '53118a2b9a8a998a75e6733af4280720e65bccafdbad7f7b430f577187c70ef4'],
  ['steel|SGP:steelPipe:25A', 'd273ef078af5737d712de66b1b03a756b9bf5ac8a2bf29bd425db896cc50b810'],
  ['steel|SGP:steelPipe:32A', '507dfcbb4edadca133e88dd4f56f043ac65f05afd5121fdafe087d532ff0ffca'],
  ['steel|SGP:steelPipe:40A', 'bff30956b2b131550ba5db155b3dcd16ab68d5048fa1b393a0dd827a2aa2d3d7'],
  ['steel|SGP:steelPipe:50A', '3c873bb3f3fdf5e311dfd4b752408f78d97752405339fb333bab3790030c914d'],
  ['steel|S45C:roundBar:φ11:hotRolled', '6a3c94e4763b3765fdb03f5efa4bee45f090fe69a72a99744fb4c8a5c3f03c85'],
  ['steel|S45C:roundBar:φ13:hotRolled', 'e9bc9eaa1adb8b1987ec6e48daaa7df1221bf993d2f2440d59d4ce54c1d586b2'],
  ['steel|S45C:roundBar:φ16:hotRolled', '88f2a414fb21710573d6d6838baef53687deaec4b734ac8e314d3b994b1e4512'],
  ['steel|S45C:roundBar:φ19:hotRolled', '0d3d0fcdf85156cea7066c9c9a07ade5818ee43ff950eaf0a9af004fd0d92926'],
  ['steel|S45C:roundBar:φ22:hotRolled', 'ba50830db6fce184435ef7fba4346e3becf4736a3efb9e7c2186eae08c2af3d0'],
  ['steel|S45C:roundBar:φ25:hotRolled', '8338c7e58bdb5f368bc053b10bf83717f820ae822cd699b441e4930b54176328'],
  ['steel|S45C:roundBar:φ28:hotRolled', '160bc70ace1af2620a966850833d7d5bf05befbb9822f3e99450d41e67a41200'],
  ['steel|S45C:roundBar:φ30:hotRolled', '6b855c82ece9904cae44a099ebd341b2c50490f19573141fca29a567f0fdccd6'],
  ['steel|S45C:roundBar:φ32:hotRolled', '50d583c4177a2594fe6088682899fe29d12b36856c3f4e11d07f1ea247fab650'],
  ['steel|S45C:roundBar:φ34:hotRolled', '5202f1f98fb221a8abc18ac6bcdb342fc66f80a055adc994c508875503dcae6b'],
  ['steel|S45C:roundBar:φ36:hotRolled', 'beaac077ab94cf47ba8adb0cfad6bc634f7ce788044450ad2e21fa17c197bbb8'],
  ['steel|S45C:roundBar:φ38:hotRolled', 'a04318f6b4f62ca560aac7af9f44669f1ef0a25c332191353b6ed4ffca79881a'],
  ['steel|S45C:roundBar:φ40:hotRolled', 'b0295ebc04669ac1f8f245ea5acc4a30543083f0f8037680b2be583f58ba193e'],
  ['steel|S45C:roundBar:φ42:hotRolled', 'b7653c7150afedc3a0fb0bc94833bd7e6656bf6012f88e74a8a8d1f708335b3e'],
  ['steel|S45C:roundBar:φ44:hotRolled', '2892e9269bc90a552f602fabcab57ca1ee8e15ed5063ef7b7822384195eb1a72'],
  ['steel|S45C:roundBar:φ46:hotRolled', '80de13a20b1450448ab4ad9bc934ffb0e90b9ef563a5f692d9ed27d776a65708'],
  ['steel|S45C:roundBar:φ48:hotRolled', '33f22affb4e26d31be3c73829ccab2a73a5249f2738da18b4b8d1df639056405'],
  ['steel|S45C:roundBar:φ50:hotRolled', '1ad6c5f09d0308a09e3d8b91f674ab26aa3f1a653ad6d08de6183f256a841aff'],
  ['steel|S45C:roundBar:φ55:hotRolled', '80e0fc83394aa9f04910a207489a97e4a3793c6dd77992d17e36d7a17f8f033e'],
  ['steel|S45C:roundBar:φ60:hotRolled', '214183fb51f3c37f96d568b5387eeb1c2bdac153cfda453caae06559382df997'],
  ['steel|S45C:roundBar:φ65:hotRolled', '8b43dd0fc517f61d608032a487079313677e5586c3fe93b6db05de73e29333ec'],
  ['steel|S45C:roundBar:φ70:hotRolled', 'e524f88803da21e0dbf79ec2cf47b932ac2739337fc2b7797b6828fbfeb94fa9'],
  ['steel|S45C:roundBar:φ75:hotRolled', '29c32b0902fccbc4d8d3c28dcfc00397314829fb6e99dfb45e70054f82ac4ade'],
  ['steel|S45C:roundBar:φ80:hotRolled', '454c4ffb10e00455f1a65c6122073334789af155db1e83e99009e8aa67056238'],
  ['steel|S45C:roundBar:φ85:hotRolled', 'bd4b74dd5c3c4d624bd0244d18e5fcf870b439a7709ab87fb1240d7f1eb16447'],
  ['steel|S45C:roundBar:φ90:hotRolled', '5f2c6e0859d18a07af4de453310c955cefc823d1486ba228444bc487aae04090'],
  ['steel|S45C:roundBar:φ95:hotRolled', '950c2febcf65f9b96338cb5b048eff7e569ef2a90ed6fc93987f2a2c40ba362c'],
  ['steel|S45C:roundBar:φ100:hotRolled', '561aa4d93f3e623e61f9100fdbbf29e9256a679970ebf97adfe01258b398c452'],
  ['steel|S45C:roundBar:φ110:hotRolled', '13adaafa109ab495eae32fbc3a30e1d23f1c69d984373560b473bc282675de58'],
  ['steel|S45C:roundBar:φ120:hotRolled', '2c0bc3c28cb3bf3168a7f97b2b05de256382ebee9e6d99e4201ed515eb3d92b5'],
  ['steel|S45C:roundBar:φ130:hotRolled', 'ac4e9a8d7648f00889d217d73ce83da166f3f92da95c26ef73cca78f8be4a7ff'],
  ['steel|S45C:roundBar:φ140:hotRolled', '238fc33d36ad807783111e0141b8a78574a2ee6f9e0cdeced882b6364da7ffe2'],
  ['steel|S45C:roundBar:φ150:hotRolled', '1130b4007b06bd92f2be7774f278a3b7c803f2dac76c6d788e9d07396d862b87'],
  ['steel|S45C:roundBar:φ160:hotRolled', '9e65923916a0e0057a5f37845073df5331895117a1e7857bc7484be0da4b738d'],
  ['steel|S45C:roundBar:φ180:hotRolled', '4e2794d2e417c72de9e05c3d3f34b523c8319d5b1728a9334a5dd2c10fdab72b'],
  ['steel|S45C:roundBar:φ200:hotRolled', '4fd9b190f36d3d4d701c0e544153e0acdfa7d2415b77ccbd2b25ecdc2d4362f1'],
  ['steel|S45C:flatBar:FB 25×4.5:hotRolled', '92c5017d6fc1221c4079e74a6afd140204ecc80fdb3becae73eaebf86249a543'],
  ['steel|S45C:flatBar:FB 32×4.5:hotRolled', '41e88954e288d391fb350da0c6e4dced6957976903d1d37e47305b9d3869b048'],
  ['steel|S45C:flatBar:FB 38×4.5:hotRolled', '307cb9c3c5bf0fe2cd53b8540d22c47559e4c67edf98507977f76aa91138de12'],
  ['steel|S45C:flatBar:FB 44×4.5:hotRolled', 'c2f525a907eeb6081329a742c7440c4fcea3d1524ecd0189cc16ba19a579b8ea'],
  ['steel|S45C:flatBar:FB 50×4.5:hotRolled', '3e87cf4ed0e20ba4841bc8ae5b2367c97c5c5e161eafb506eb3b9978994eca04'],
  ['steel|S45C:flatBar:FB 65×4.5:hotRolled', 'edf762debfa89ec49f01d2fadf0fd2da3d4f7be1446d0230344a97dc133730eb'],
  ['steel|S45C:flatBar:FB 75×4.5:hotRolled', '76cf96fe505dc7f3d47ccc6d5210eb4a4450ce4db2596edb014d820316e65b18'],
  ['steel|S45C:flatBar:FB 90×4.5:hotRolled', 'b67cd15d9190f891f6523669cfddd508fe03fc44b49ea0bbf1269120248cbf4f'],
  ['steel|S45C:flatBar:FB 100×4.5:hotRolled', '00f413a452cb8c81aea6fb558dab05efe93012d3cfc6de47ff4573630bb3b5d0'],
  ['steel|S45C:flatBar:FB 125×4.5:hotRolled', 'c7c19e7a4c1b8f631eda1e1578281b7e1b8363cb5a298ab4af951fd1e25acd8c'],
  ['steel|S45C:flatBar:FB 150×4.5:hotRolled', '1546316962a3e535a83bc7cbcb37658d878f7134679a51f90c537067c66cd2cf'],
  ['steel|S45C:flatBar:FB 200×4.5:hotRolled', 'e110770ac0daad4c46ddc03d943f45f676ecfb9628715506023c00bebc699144'],
  ['steel|S45C:flatBar:FB 25×6:hotRolled', 'd02edb03ec143740ce99f67f916a5c487de02aa645c1d3b8405a45b2b9463186'],
  ['steel|S45C:flatBar:FB 32×6:hotRolled', '705ea1a00e89c3325012bac8e3de11e2c04ebd9bb8c9d17142f3f9f22ef99902'],
  ['steel|S45C:flatBar:FB 38×6:hotRolled', '8b0ce6e1e5c77af4b4c68edecd5888ebd395a1dd47927f4695c2bc318abf294d'],
  ['steel|S45C:flatBar:FB 44×6:hotRolled', '3d88a2a7e6cc9654af52cd27074b78f2b80b6d7d3391b6d7d5acdc0c8526daf1'],
  ['steel|S45C:flatBar:FB 50×6:hotRolled', 'f00699dd1f9c1c83ae0a8699cd1b204cda1875bb86999f3997330b48d9a36708'],
  ['steel|S45C:flatBar:FB 65×6:hotRolled', '0007c23f28c6eabfa86c1ad468e816c3c879b8abfa5a9d77ad0ddfbc35b6b416'],
  ['steel|S45C:flatBar:FB 75×6:hotRolled', '36301a375776b3ea5ec4ca57f4e36883942eb979cda854854a362998391ba37c'],
  ['steel|S45C:flatBar:FB 90×6:hotRolled', '9dc58db4063fc0edd1e83121097209138d6fa491cc7db7b9bbca2a4159408080'],
  ['steel|S45C:flatBar:FB 100×6:hotRolled', 'd6ae9f0d7ee534fc870af07294f6ff2d7c822b6c30d7756d9f6afe2e4307de07'],
  ['steel|S45C:flatBar:FB 125×6:hotRolled', '292b5358cc06bccd06a6f3de0534f649503de5a5536b541aa3c722712a2eb1e3'],
  ['steel|S45C:flatBar:FB 150×6:hotRolled', '75438b382468028768cad48892a68dcca44b6f16af07c8c84ab21f52d769733b'],
  ['steel|S45C:flatBar:FB 200×6:hotRolled', 'e7df8d1a5bd5a3db82277d4eec7673f7ab44a205caaa93f798497e7d105c9882'],
  ['steel|S45C:flatBar:FB 25×9:hotRolled', '6fc03fde3541fee66ace6df9055ee1d9907569f7c581217b0d3ccfc0f5dcdf45'],
  ['steel|S45C:flatBar:FB 32×9:hotRolled', '8fae8461ac66e9aa6e0ab75943e83d2e8ee57726d6fdaf24007841539b223cc0'],
  ['steel|S45C:flatBar:FB 38×9:hotRolled', '1dea14476f0072178f3172335a88f5513e3eeb65db4e88324124ce9fe89c6f28'],
  ['steel|S45C:flatBar:FB 44×9:hotRolled', 'c9f1136a46a3e19425ae0d19af54ee7caf595a44df4ee41e8cf08fdfab4b2b6f'],
  ['steel|S45C:flatBar:FB 50×9:hotRolled', 'ec557222dd323f10ef21511eb379ea7493844719f592bbb6b92f873339a77ab1'],
  ['steel|S45C:flatBar:FB 65×9:hotRolled', 'b120ed164606d72552acf1c86f8146749609965c0f1b596592d8dbbc141cbc1a'],
  ['steel|S45C:flatBar:FB 75×9:hotRolled', 'ccbbfae5b43176bd7bff0f5a19a5e4d79b47b7d566786cd21a724d0aaad44ad6'],
  ['steel|S45C:flatBar:FB 90×9:hotRolled', '07c62352e3282fd61ca2d690c8fef188beb07ceb8c80c655cdd949c6e2755554'],
  ['steel|S45C:flatBar:FB 100×9:hotRolled', '89c75b5ed6fedb1cc055c66901dc7f7b0dd76782b95d8230bf9fdeb5aa41ceff'],
  ['steel|S45C:flatBar:FB 125×9:hotRolled', '3c8648fabfa173cd41c04abda9b76684e3d82ba27d58d23463cfdec519cbb5b9'],
  ['steel|S45C:flatBar:FB 150×9:hotRolled', '65fcd6c3db9920a9dacfcb383d44d433874c401d4b3f16f7ec0dc5bc5a55cb26'],
  ['steel|S45C:flatBar:FB 200×9:hotRolled', '180e68271bbdb3055dc2a852e6e8e636384d8daed16c30594504908facf5a4cc'],
  ['steel|S45C:flatBar:FB 25×12:hotRolled', '597537a69175aecaba11a363d018857a8d6cd9767510091cd9dce88e47a8df66'],
  ['steel|S45C:flatBar:FB 32×12:hotRolled', 'cbb430bc9fbcdd02385aa74ac223306025757ea738dd363718f21bba835d71c7'],
  ['steel|S45C:flatBar:FB 38×12:hotRolled', '86bcb04006968e12922cf40ee069dc88e6eb152b597730e547ec005475c0b04a'],
  ['steel|S45C:flatBar:FB 44×12:hotRolled', 'a75318874e6c186623382965ff15de83e1161e5e4bf520b5ad4d2224cd169961'],
  ['steel|S45C:flatBar:FB 50×12:hotRolled', 'a6716aa76a80555141daad3d95f7547086bfd7322d97745f03be92caaf85d9df'],
  ['steel|S45C:flatBar:FB 65×12:hotRolled', '2b7a8adfbdc548dc2dc11df20f197d8a250ce08aebe046d27458b4562a36fb23'],
  ['steel|S45C:flatBar:FB 75×12:hotRolled', '4fa933bddab5d8a627111123b1791ae5b4abe8dedf570ca22253f65296505ada'],
  ['steel|S45C:flatBar:FB 90×12:hotRolled', '232b5169a1f35503aa698147de862c831ab8c29423803a98b20b7ed2ff70c842'],
  ['steel|S45C:flatBar:FB 100×12:hotRolled', '9bf606607bbabac36057ec6e8597403dbc8e02b80a1b1549f3d1e50c9e5d4cff'],
  ['steel|S45C:flatBar:FB 125×12:hotRolled', '945775c65ffd13390a506e59162781338da91606e91bba716e96e0c3214b124d'],
  ['steel|S45C:flatBar:FB 150×12:hotRolled', 'b0dcc0e36d1138773c886a36aa115f9267be748f1120a1d32dafa2f6b4f2607e'],
  ['steel|S45C:flatBar:FB 200×12:hotRolled', '79bd09eb5338e42ff99e3cd644414a9a5c834dff7ab77b468dd0d96cdd494376'],
  ['steel|S45C:flatBar:FB 25×16:hotRolled', '36fc7919eff824e6e80102c7f08992e9c16c8658a7393e8a88d3d45ae1abfbc2'],
  ['steel|S45C:flatBar:FB 32×16:hotRolled', '1387167de8742d19b28718ba793a55d1c346b99590db6bddd62ac0a40edb3572'],
  ['steel|S45C:flatBar:FB 38×16:hotRolled', 'd7070bee5c4a309a07bfa9c56e320886bb42bc9c0aa191f115ae6ac9b77034d3'],
  ['steel|S45C:flatBar:FB 44×16:hotRolled', '9d95121063f50bc638d4a0ccbac35db62beb4f28ecfd8efaf63643e6ad060a73'],
  ['steel|S45C:flatBar:FB 50×16:hotRolled', 'cd22f12e8949b6e46940f4483ae5ee27f605927bbe56b7273a764ba1654fabd5'],
  ['steel|S45C:flatBar:FB 65×16:hotRolled', '24354d6754a009661786a07a8038919f7e56d6491f251dd1ab7dd318bb89809f'],
  ['steel|S45C:flatBar:FB 75×16:hotRolled', '653bd55f6d68ab52438a10c0078ef83e59d53d74b7ba592c4f35c1b1c5ab3fe3'],
  ['steel|S45C:flatBar:FB 90×16:hotRolled', '531f41fc893aab2a0cc4a3140b9bebd315455d4ea0ea7c104109bc5489992132'],
  ['steel|S45C:flatBar:FB 100×16:hotRolled', '6cc4b9b8d34ed257a46e0b0458ad7dce261a5bf599b4ba2d6aa29d087331f714'],
  ['steel|S45C:flatBar:FB 125×16:hotRolled', '9db9d9bd46e4a211a3abe82ba0254f0a1b1b68ca643acaedb71dcc57dc768fa0'],
  ['steel|S45C:flatBar:FB 150×16:hotRolled', '19b5b5803ffbcd8c42e40eb306efc20355882482bbdcb129bcc82000b80ec8d5'],
  ['steel|S45C:flatBar:FB 200×16:hotRolled', 'f32d9c04c254fffc45a044dcfdcb5c328b1e014e6b53bd596a9976057eae1339'],
  ['steel|S45C:flatBar:FB 25×19:hotRolled', 'd1a6f6f1c6583f5db4b4e1fbdc246ab2efcd97e22a9948f3709876d886371a2b'],
  ['steel|S45C:flatBar:FB 32×19:hotRolled', '65acdaf8b592d08fddcdb6a9b50abe6b5b34065027818a3f049a820e0e770264'],
  ['steel|S45C:flatBar:FB 38×19:hotRolled', '2f950d47c26620ecc65b4e9d8d481487eb74e4f0e8f63b86578b86dcf6fea649'],
  ['steel|S45C:flatBar:FB 44×19:hotRolled', '6a3218d99feb0bde31b7a545cf9429587f3814440d8bcccd2dd7623d6758542a'],
  ['steel|S45C:flatBar:FB 50×19:hotRolled', '79d484f4710a4c0a50af7df6610ecf6fb17a61c29c61e5d9c950ea456c3b7a03'],
  ['steel|S45C:flatBar:FB 65×19:hotRolled', '7b5b33137cb7d1fa23323a62485ce3bcdf72217a36fe3cb183229b4ddd3fb505'],
  ['steel|S45C:flatBar:FB 75×19:hotRolled', 'fdf150e550a29654057f175052760ba26621c5b0b136e84ec80fa9d2d815af00'],
  ['steel|S45C:flatBar:FB 90×19:hotRolled', '41177689b23917fa0fb4c1a9017048c736d3c2400960a51c6323be563cb9701e'],
  ['steel|S45C:flatBar:FB 100×19:hotRolled', '55fbadeb363dbadc567ec20ea22a8eba852ce3c50436958394c884adf4b38c4a'],
  ['steel|S45C:flatBar:FB 125×19:hotRolled', '724e4031aff2fffdddb99d7880e08a2732db4b3c601e7a92ac9a8b70a79dd680'],
  ['steel|S45C:flatBar:FB 150×19:hotRolled', '24c18e592ff0e775d79844f91c346d4d098c21a483622673407de0c59cb3108c'],
  ['steel|S45C:flatBar:FB 200×19:hotRolled', '7913adcaedc020de210667b73b87c7449687aef7db7bd7c0180ef13d2482a0ee'],
  ['steel|S45C:flatBar:FB 32×22:hotRolled', 'a94fcfa2ac1dbaebe49019046817f5ca6b94409abfd7ea1efed605e1664a5710'],
  ['steel|S45C:flatBar:FB 38×22:hotRolled', 'db7b5d0f4e2a9bbe052d42ea04829ec8616f4ff9ed1a50f2c47027a02fe70943'],
  ['steel|S45C:flatBar:FB 44×22:hotRolled', '5898866dbd60bee2bea94e4f28f36bd5e3f0425aece414d1bea1f15bc5e8191e'],
  ['steel|S45C:flatBar:FB 50×22:hotRolled', 'b5ffb07aed8603bbae1a0b3271730eb7f0be95d9d8142eb9d048e87edd8e76b1'],
  ['steel|S45C:flatBar:FB 65×22:hotRolled', 'c56640e90e50424da5cb100b7dbf1c37fd35031091d20d56f0dbb9aa525dd9d9'],
  ['steel|S45C:flatBar:FB 75×22:hotRolled', '18307309b21f5ed8ccb75da642b44df7ecf2202ac96186dc823953d2a8c94636'],
  ['steel|S45C:flatBar:FB 90×22:hotRolled', 'cf5b9dcda62fcf2f0c6d6ceaf46a53bd527c026eadad1d38865c5b31c65a250a'],
  ['steel|S45C:flatBar:FB 100×22:hotRolled', 'ab8cd841c0ce8f2057c96d37f30cd5b6ceaf25ae79e58879d8727df518040821'],
  ['steel|S45C:flatBar:FB 125×22:hotRolled', '29550d1b439618dbbe0c676bd22697488674153b96087a3ee22f435e75397915'],
  ['steel|S45C:flatBar:FB 150×22:hotRolled', '645d84f1671843045fe5d24a87f25e231dc815eddca030165baaf4f390bafb29'],
  ['steel|S45C:flatBar:FB 200×22:hotRolled', '2c180805b582d69cbed92ba83011cabfbafb5eaf62ed6d47049f732cae3f89ce'],
  ['steel|S45C:flatBar:FB 32×25:hotRolled', 'c99fc4553741be53fc3cdd0a573b08fbfa8c957b2a9a90d66a48d9537198ffdb'],
  ['steel|S45C:flatBar:FB 38×25:hotRolled', '2f3d8533a74b575ef31116bae1777d02e72145fa261ad61abe36aa5077202669'],
  ['steel|S45C:flatBar:FB 50×25:hotRolled', '4fc30be658b56b691ff5c18e98abd2b09afd0f5cf1ceed762050508de7c4f060'],
  ['steel|S45C:flatBar:FB 65×25:hotRolled', '24a72ab3fb286553b97ff2f5dca04dea0364ec0b2caf0500809caaa2d08d4304'],
  ['steel|S45C:flatBar:FB 75×25:hotRolled', '215ec61f36eb679b24bcc853a4041a7322434a610e09f605d4529b9bef732550'],
  ['steel|S45C:flatBar:FB 90×25:hotRolled', '26a63373d4c3f5b64902b4ddf60da08790e2b00ff411f5c18d184c38f9513d7b'],
  ['steel|S45C:flatBar:FB 100×25:hotRolled', '4c68abfebbe9ae1794de73eeaa2efb16718a98699da239295b54c18a4b52b8e7'],
  ['steel|S45C:flatBar:FB 125×25:hotRolled', '972dab09fadc20a6ef6b48ebc07da79510567b8e02c96f7af055760940758aa3'],
  ['steel|S45C:flatBar:FB 150×25:hotRolled', 'fe5664f97d5251d7497bc99b5bcd855a887fe343d7fb5432579207a1ad7e1c1c'],
  ['steel|S45C:flatBar:FB 200×25:hotRolled', '0ff18aa2180110716100de2daebc2336d638b752ef049f43f2445407cd73c33e'],
  ['steel|S45C:flatBar:FB 50×28:hotRolled', '90531eca3f8447c64451b323532172ca721bf775eb8c9a5b300b5e9dd0f63aeb'],
  ['steel|S45C:flatBar:FB 65×28:hotRolled', '43bebbc961f47086c4e788f1ccf3f064c1e2f97d33b3528e3fda92ab3417f925'],
  ['steel|S45C:flatBar:FB 75×28:hotRolled', '466fdee3ebe70a5090856ff34dedae24869a55db48e2ecadc22353bfe4f09180'],
  ['steel|S45C:flatBar:FB 90×28:hotRolled', '65c0a52a629e08811dbfa4e58de89ea882159413854ae98a140509e6efb18d91'],
  ['steel|S45C:flatBar:FB 125×28:hotRolled', '4f0cf69fb48b9d018c5b53f06c57b14ab3a7fcbf4100dda55c7c59796a6d08dc'],
  ['steel|S45C:flatBar:FB 150×28:hotRolled', '67a99aac57245711730530dbf50a99f584738283726f69abdfc42dd54afe55ce'],
  ['steel|S45C:flatBar:FB 200×28:hotRolled', 'c37f086dc54df8f717c8ff3f84a931d6cac79089c0bfad41e6dc8bc92680d137'],
  ['steel|S45C:flatBar:FB 38×32:hotRolled', '8235b7dadb8db0bc72331af44d03281882db869f23540b990846f3b24792752c'],
  ['steel|S45C:flatBar:FB 50×32:hotRolled', 'd7913d47ee836d22869ccbb0d8e5cb55b04d0880ae96496e99093cece4fbc85f'],
  ['steel|S45C:flatBar:FB 65×32:hotRolled', 'b3c8b07d347dd1df5be1f44ec6e0f0a0dadd07b8f0d1348cece0e4042e3d57f5'],
  ['steel|S45C:flatBar:FB 75×32:hotRolled', '443c005fdb307a63acdd7f9f7b7c1f30b050cf1710d23710f95372210aa20a4c'],
  ['steel|S45C:flatBar:FB 90×32:hotRolled', '280bfd9fc325c5b610cc7818fc48f6bb122e1b2b0f0b703db67295e857b1ee40'],
  ['steel|S45C:flatBar:FB 100×32:hotRolled', '219aa346dbd7a27644d341e989e1ac6a39fb6119f03376450cb953c640cbf162'],
  ['steel|S45C:flatBar:FB 150×32:hotRolled', 'c3fd96cf046b41252a493af042f3bb8ecfd0baeec703cf6eb2ed273d14e2cd8a'],
  ['steel|S45C:flatBar:FB 200×32:hotRolled', '93f526e84cb0f567b9054c30883dd615fa7bcb29b44becdfac7272cca5c5fc85'],
  ['steel|S45C:flatBar:FB 50×36:hotRolled', '7433dbbcb831c7075a76ff6c4b73827aeb7a1fc77fc54cd9ad6bd2ffb6cfea66'],
  ['steel|S45C:flatBar:FB 65×36:hotRolled', '536b5d7335bb359bb30d761e494e33bce059f0cb56a9e20437bfdd64d3310421'],
  ['steel|S45C:flatBar:FB 75×36:hotRolled', '73ca0db8be4e6ab7fd46bbd6982d382fd2d8e6f3067361f3aee628529993ad7b'],
  ['steel|S45C:flatBar:FB 90×36:hotRolled', 'db15a8019febf30e76fe9e44b95d94d59ddca7398814bf4403507d9828e30639'],
  ['steel|S45C:flatBar:FB 100×36:hotRolled', '7eb236eafd9b221f21b4f6a5f5bb3f27a2d4b782d5519f05c1123af57094d124'],
  ['steel|S45C:flatBar:FB 125×36:hotRolled', 'aa454056313169eba01bb811589fbc1b2dc8fe66e67913ecb7cc3ecd0da5c2cb'],
  ['steel|S45C:flatBar:FB 150×36:hotRolled', '6193e43ea2d7161abb3059bc3555f339d5ac6d7310ae2aa5ddda943f6293e6da'],
  ['steel|S45C:flatBar:FB 200×36:hotRolled', 'e582239e3aa54055bba86c42fd9cddb31989035330e7d0221a92b9f1a4a58941'],
  ['steel|SS400:flatBar:FB 25×4.5', '8181b9dd0665771d15284e7717cea7e26d3fb78fe36436f3d69b31a84212b5bb'],
  ['steel|SS400:flatBar:FB 32×4.5', 'd7c53fe31bf8c98c48302c7829bbcce83cafa4ca30a215865185274660881d5f'],
  ['steel|SS400:flatBar:FB 38×4.5', 'ef613216078909afb74188bd4e16e9c9098dfa94ef5485cda0ebf49e34867726'],
  ['steel|SS400:flatBar:FB 44×4.5', 'ba3024c2a354a0a1b24a00d6bcb8efbc4b8a2e8ba43df6879b0192ef4e86b15f'],
  ['steel|SS400:flatBar:FB 50×4.5', '11bde25bcad78bef12c9321281374ca3628e92df7ee7417a3eacd9d8704092ac'],
  ['steel|SS400:flatBar:FB 65×4.5', 'c8a4eb61543e39346d7255b424df735af55c905a70a8975256ce984c969514b2'],
  ['steel|SS400:flatBar:FB 75×4.5', 'cb87eea352861bab5d0e3654c7ce130f74067f9e78dfc98684c9be897ae143f1'],
  ['steel|SS400:flatBar:FB 90×4.5', '8ab0ef62de360a4a58309d26b8a5477840ea82ad1722a69525c2936406ad2be0'],
  ['steel|SS400:flatBar:FB 100×4.5', 'b1e2219323be10d48785709dd1479b3f4eef422dd3fd679674bd09523d80c67b'],
  ['steel|SS400:flatBar:FB 125×4.5', '670527bd6ed6eabbd93f897fbe56d0218d44c182702a3281f0901613c19ee9ce'],
  ['steel|SS400:flatBar:FB 150×4.5', 'd0ffc898a8659efe2c89890d5ba2cf36da8d61f94d78f581374b6099a486eacf'],
  ['steel|SS400:flatBar:FB 200×4.5', '8b9037b9fb6e9e92dd55addb110cfa9f0fd6e1849d6d71d18b1f37e51f205131'],
  ['steel|SS400:flatBar:FB 25×6', '2cd269d2085f4ccb6d753409fd412ad5e6d36e05252c2a4ef84399bc8ead1c72'],
  ['steel|SS400:flatBar:FB 32×6', 'b0d2ea36f644b66e78d3afabb381cc6010d0a80bbfc484ea78093d1bf480c68a'],
  ['steel|SS400:flatBar:FB 38×6', '545ea6aa3a8a838da54fa73ed73a526d2b778addd3a049e02219682c10e5362f'],
  ['steel|SS400:flatBar:FB 44×6', 'ebf7392bb296b73d7f4f8fe90cb19291116d1edd032baf4d2acc7d64772aea3e'],
  ['steel|SS400:flatBar:FB 65×6', '7c80b1fb7e533c20a6a91fa5bd78751a52b09414d57dfeb87a2872a02e953e44'],
  ['steel|SS400:flatBar:FB 75×6', 'd85e143ecc8a32acff0331fa1d161a2f5a5a212f6b1d6b38db5a4868418e6384'],
  ['steel|SS400:flatBar:FB 90×6', '6eceafc3daa96408a16b2ff28009da28b61756d5e43f9481e17c07b0fe7af248'],
  ['steel|SS400:flatBar:FB 125×6', 'e0606983c3fbe6465c0b4ba7fee4a941154c2a6ed188ea13ed839984de95a3cd'],
  ['steel|SS400:flatBar:FB 150×6', '6a154cd4cc3869b78c68d3b8ec70f2ce671969fc4cabd7f41d12a20d14283b5d'],
  ['steel|SS400:flatBar:FB 200×6', 'ea7e3b5f86dc31761e19a3c14ef23e1a1507126b1bfdb4a072086c2abb0ac082'],
  ['steel|SS400:flatBar:FB 25×9', '78c7c86f3cd908b5bffd1dd91f3cbe0017983ab59e24576e67e2f31915a2fa9a'],
  ['steel|SS400:flatBar:FB 32×9', '03c7f2d240415ac0db18a73964e83d694df94ced831e414e5dc7a0f759fdd2dc'],
  ['steel|SS400:flatBar:FB 38×9', '710810d244561c1e8e27835620835c2ac043cb416fa29b34ac59010c493262e5'],
  ['steel|SS400:flatBar:FB 44×9', 'c5eeefd04401255773c1181dbe46f2da81feb557694602e746af27e2a7730604'],
  ['steel|SS400:flatBar:FB 65×9', '4bc0aceb345fe9db8fd71124417dd5aa964ff80ba0905a2d6cdae5142c3a722e'],
  ['steel|SS400:flatBar:FB 75×9', '9f7c3de4a04d50253cb24921d8e5a3971c2dd1ad78c9ef16a6f09ebb252f3f16'],
  ['steel|SS400:flatBar:FB 90×9', '7f0a725c9ae0ee63dd7b8719e207191ab1922b397c776f2d84a9d47cbf4f4435'],
  ['steel|SS400:flatBar:FB 125×9', '850a2d1e1e3d0b66e56128af2cdcf4c94c9873a94821ef51bc4e6fa700e808fd'],
  ['steel|SS400:flatBar:FB 150×9', '9e6eebcee90cb4f373dcdc04113f8483bf9abb65c7b373a3bd2d302c3c4b61fa'],
  ['steel|SS400:flatBar:FB 200×9', 'f089d135aa1be645840cda2ba2f7ebd5e297d72a0561b29bf1cc4f4f53eb2321'],
  ['steel|SS400:flatBar:FB 25×12', '8b1dd2fcc9a85b73818d2461641ccd1deaa5824e2bcc5893ec2cb7b78452627f'],
  ['steel|SS400:flatBar:FB 32×12', 'd758b3efc7ddf69bd0f70ec622b80ad7f7f55cccf20ddd9f0a18a2f227f94506'],
  ['steel|SS400:flatBar:FB 38×12', '4bc8c573a62d0f52b6839d289a788c8ea639feac500c46447bfc7239bf6d497b'],
  ['steel|SS400:flatBar:FB 44×12', '311a876ef5b0a92dcaa5fa7096e797743761224842d4d12844d96ee98d3fac80'],
  ['steel|SS400:flatBar:FB 65×12', '59b56bac65f42a4521e5ece7c8ee9c5a2c5f16a1fc61f3a38833229baf5e8b51'],
  ['steel|SS400:flatBar:FB 75×12', '11207e8dcb6812c0e3812e2656748f58c21215130f8a46aec67d3f996e3e27ca'],
  ['steel|SS400:flatBar:FB 90×12', '03056e7181f572299b9283fecf4eaeb43278c3c447dcfceb2e4bd12a22efa4c7'],
  ['steel|SS400:flatBar:FB 100×12', '9dfe303bcdcee041e6d74c5e3d26b406348ea6c527b288f816232ae5b4e3d182'],
  ['steel|SS400:flatBar:FB 125×12', 'b1f318a4b25cd246db171d3319af8c0837d3286ac5b1caab6f3d0250d427ca43'],
  ['steel|SS400:flatBar:FB 150×12', 'ea0bc44dc5db1db68f22cf23053be0531d02491e8d9c3d52a5f5c9727d9c1c62'],
  ['steel|SS400:flatBar:FB 200×12', 'c547b6622a8554110d79f7e2a47ba6234d2fb61659a4a42cae749a1bb3300295'],
  ['steel|SS400:flatBar:FB 25×16', '19ed8737dea1d776bc9df0a4df7ba86c7dd834da16a99858e59b1c8df812998a'],
  ['steel|SS400:flatBar:FB 32×16', 'be23aba4a0ffcb601ee0fe009a9132bbc7abecc1545203961b5625e961534e54'],
  ['steel|SS400:flatBar:FB 38×16', '00c197976d35baa69058d72fab16ab428ec8e8d436cea7e9891b2b1effe6db26'],
  ['steel|SS400:flatBar:FB 44×16', '259861a454790ca10e5f3abbf31d40d86884bf4406cf86cd5474b87c606e9bc1'],
  ['steel|SS400:flatBar:FB 50×16', '02cd30721d5d1630b6654391091299bf11901513d6550d072578cd55ac654e42'],
  ['steel|SS400:flatBar:FB 65×16', '12abcd41fb9e04ffb1ca2a75a0e99a040c403bd5f23add50182d93e29472e405'],
  ['steel|SS400:flatBar:FB 75×16', '15d504607f9f70c287a4662186b483409e2199ffbf5ccd3acaa6e017a45f9042'],
  ['steel|SS400:flatBar:FB 90×16', '14954980912e70138dbb8452b3525688e7600069fa37472c2b41e28f8a9d005a'],
  ['steel|SS400:flatBar:FB 100×16', 'e2b738fdc750f8550ae749999da944f2bd11627c692923343469cad4820a5fcf'],
  ['steel|SS400:flatBar:FB 125×16', 'd82efa9941d58a320ba454df11175d363929f5d1a7cbd70ccc1efd67b6094986'],
  ['steel|SS400:flatBar:FB 150×16', 'a3dcf56a1a5bd5ca59a5408f6424932d37970ecf96d17ba2b6632a7c3f452b08'],
  ['steel|SS400:flatBar:FB 200×16', 'f470be9b8549c5ba5adfef9dfa8e168ff0621254ab59b225930f36ae05d12a97'],
  ['steel|SS400:flatBar:FB 25×19', '10befa98239f24e98c121514c43e5fee4d93f302933e732564eb1952962bbcfa'],
  ['steel|SS400:flatBar:FB 32×19', '102570688cdaeb3082a52c53cde3b258c087d913ce7e3aafbdc02722c0a2e97e'],
  ['steel|SS400:flatBar:FB 38×19', '30ded9cfb280a71fbff0ff711015537e62bd5c98c0b7761a31fe716c19d0b491'],
  ['steel|SS400:flatBar:FB 44×19', '2ee67685e4c32ecfb2bf83754bd995bf2d6a18d1c3f26b470f9da70c07e25a80'],
  ['steel|SS400:flatBar:FB 50×19', 'fa5a801498252b3738bca167aea68957bdf881e6e47d2d50021933eb2e8564ce'],
  ['steel|SS400:flatBar:FB 65×19', '81834815d3d5edca1a28c3ef9d03566a411a2070cea5f12554461a778f6ae182'],
  ['steel|SS400:flatBar:FB 75×19', '5bc7e23588fb86be3939a6f85504a7525cc96ca4e662de58b66c1db22249b2ea'],
  ['steel|SS400:flatBar:FB 90×19', '7c6e566ce86992944811432c334ce5faf9acb07ccc3a2ea8721ca2f66c43ecfc'],
  ['steel|SS400:flatBar:FB 100×19', '969695ac25e3334694fecb157b547f7ce3b38e105b97c5fba2fa90c3ef65ac83'],
  ['steel|SS400:flatBar:FB 125×19', 'a3f05ca97ff6beceee82605a96fd28afebcfa786b149c339a49a515974ef5fe1'],
  ['steel|SS400:flatBar:FB 150×19', '1d76b7d84ebc8a3109fd4d5428aa09420481f6e54ed3199e6b012a13c704cf13'],
  ['steel|SS400:flatBar:FB 200×19', 'ea7a330b2de89979850325c7914d34e5beccecc812ba3a0ce10de95cd9370d37'],
  ['steel|SS400:flatBar:FB 25×22', '4bc099478079220d37efdd467b6ffcbe2a324ba2c13c7e51eab597c105991269'],
  ['steel|SS400:flatBar:FB 32×22', '06bde4f26936efab8e8ac72758469f2ab101918ce15c1b927ce32f13124afcf1'],
  ['steel|SS400:flatBar:FB 38×22', '036fcfa17eb9ef0e280a76ab315afa35c9732af82d8f65d6ff2604686065f494'],
  ['steel|SS400:flatBar:FB 44×22', 'e102f6bd1306129b4982540d5de2d78f94fc83d819fbcedf9a8b1a7612551274'],
  ['steel|SS400:flatBar:FB 50×22', 'e8d67076ee4f0d4ce6ef14af9e4b30ab1331d91498b9b55c91b90da821e6a70d'],
  ['steel|SS400:flatBar:FB 65×22', '242542894d5156ce9380390e362d45b5e27b2aec992e559ca966d660b8832667'],
  ['steel|SS400:flatBar:FB 75×22', '146e3e4cf87aea81d03fda4a63466fc9574ee57282671608e4ff5021eda883c3'],
  ['steel|SS400:flatBar:FB 90×22', 'a611bf3e50ab2aa3bfd83ae71769f92a8c89d6934a3450c0372a6b782ea55c88'],
  ['steel|SS400:flatBar:FB 100×22', 'fbef0185293b5c35c51f1c7b4b68d0e9fb407aca2d2e26b15ea951c2bdb0c037'],
  ['steel|SS400:flatBar:FB 125×22', '5974a03b15c165e0564aedec747713045cdfe29abd6aa58547a1ac8bad0efb92'],
  ['steel|SS400:flatBar:FB 150×22', '83b6cdf10d94a5ebac47316552f5a3e84dc3723cbbb2f99687d6f7a15704188e'],
  ['steel|SS400:flatBar:FB 200×22', '23d44c9455af3e3c8427d449fda77f910f362148ff8baeb783a9f7b58a0e4d66'],
  ['steel|SS400:flatBar:FB 25×25', '049e38502b5caa1de90253895a753690dfebfff4f9207cb778fc0d534bae9a73'],
  ['steel|SS400:flatBar:FB 32×25', 'a0294409f290ec2320e49f1e86e1ca6221232a1d38fd180c1f058e2fff1fbdca'],
  ['steel|SS400:flatBar:FB 38×25', 'ce0ed1fba6ce3fdbab2bdfdbaa8a813c7f91a42028cafa2102f0a284f2f2293d'],
  ['steel|SS400:flatBar:FB 44×25', '34f7adae003e7449ec8539190fd7120f11776beb1a32ef53f1236a3b57c26c86'],
  ['steel|SS400:flatBar:FB 50×25', '41fe861b904e551c6bb233029d71320f84a5fa1a32eaa9d2b357260487d7e6bc'],
  ['steel|SS400:flatBar:FB 65×25', '3532988269cfc8d917b33f68faaf572c1a45694c110470072372236e05aa862d'],
  ['steel|SS400:flatBar:FB 75×25', 'ab941145cde6e9d6cd8b34289a705b7182d6f06989cc702f37b676e34702ca8a'],
  ['steel|SS400:flatBar:FB 90×25', '95439df5a19f6e5d1350ea0f843b79b96028dfda9a07848f02d9f17ffdb271d5'],
  ['steel|SS400:flatBar:FB 100×25', 'd8ed845e2a1133feda5b3f8181003343c9c2ad452fc1c76864730ca66c8b9a2d'],
  ['steel|SS400:flatBar:FB 125×25', '30156902743beccd1d51cd550bd7c123e7f363363ced55036bf19b5fa7232477'],
  ['steel|SS400:flatBar:FB 150×25', 'fc708d81f608e835d04597f9a6fd560bc82859513e5199380f82eadfef37ed73'],
  ['steel|SS400:flatBar:FB 200×25', '8ed20bf7395eafc52b855f38a78ea10484e633f1dea94142618b9d4a525105a0'],
  ['steel|SS400:flatBar:FB 25×28', 'eb3ad23c919dcab185e3ebb4b5f379098eaf5296e2a319343ab7d31171e0b45d'],
  ['steel|SS400:flatBar:FB 32×28', 'b3b529793e839e3bfacff05b4150606c8bbe6b6f06a788622898ce65c2d8a7c7'],
  ['steel|SS400:flatBar:FB 38×28', '55fc7217c55f9e7dfaeb5e4e9c5e305ba0c8b0aefbd18d01abda396d5f9ad77c'],
  ['steel|SS400:flatBar:FB 44×28', '5c1ad031b3d857e1897efdbbf2e6b2c342a3028cc4455a6e3412530af5348495'],
  ['steel|SS400:flatBar:FB 50×28', 'fa8f154ac6d2ff190d07120416ca471c2dac40ea88138fd1d8efd43c4572e120'],
  ['steel|SS400:flatBar:FB 65×28', '4c003baed372f54b764307a5484197f986e11930ef30ed053da9a497ef5a61f4'],
  ['steel|SS400:flatBar:FB 75×28', 'a38139a2f5b18a5947f9b0fce567cee354392d27cc94246a192c4697306e03c5'],
  ['steel|SS400:flatBar:FB 90×28', '3b33a1858526c7f38fcd9fd3ef482426ef0349f3f9fd27badde39671cdd25ffe'],
  ['steel|SS400:flatBar:FB 100×28', '57feba2c080bc40495e55d8f1f74ade11b3d8640a233bbb7eda8c9ab2815cee8'],
  ['steel|SS400:flatBar:FB 125×28', 'd4db382f5b93883039fb48487d3cf0c8aafe90b29c9da350ba80c470007a39ed'],
  ['steel|SS400:flatBar:FB 150×28', 'a40e9e8025b38022a1a46e851c3571a9a35f2cda17ef7c02e8dd0b95980b7456'],
  ['steel|SS400:flatBar:FB 200×28', 'fd2907e0d8243d2571a1c7cc1b8b7ce2c1ed346fcce022ca86bd3f2066d6d579'],
  ['steel|SS400:flatBar:FB 25×32', '19e51d7cb942becc8b92b1a8cdb9afae2cb99237d1495b310a6a70f7aa125cfd'],
  ['steel|SS400:flatBar:FB 32×32', 'b99a18b23a7ffe922bef29fe5713c897c58edb986e685a710c244a685f985a6c'],
  ['steel|SS400:flatBar:FB 38×32', '465c6071938c8eec17696aec8dc9e673f7e6915bec871edf6c9057abee253c2b'],
  ['steel|SS400:flatBar:FB 44×32', 'fc397d9983171a0ada049107bd86d155f17cbc2bf101bbd9f8ecf0bf8160e92d'],
  ['steel|SS400:flatBar:FB 50×32', 'fa528fb650d789559c16e78fd514df8a4bb0425af1db756c432f363584453799'],
  ['steel|SS400:flatBar:FB 65×32', 'eac232e17c573961f41c1008d95a88ddb6fc2fad2ea1be2f9110e8c16c17b23a'],
  ['steel|SS400:flatBar:FB 75×32', '6c26e882cd04a26b0efc4a6a3c58160b33dd4a3d51b05cc1fbdd23bb67dfc9ae'],
  ['steel|SS400:flatBar:FB 90×32', '1b5035fff8763bdc2324cfe32997c9b96effe0f3e29385054f6c8bc5e92e16f9'],
  ['steel|SS400:flatBar:FB 100×32', 'e047b11faa5a6f301bbcdff67ff29fcaa6c9d9b68f47c9d8f89a9110cf087983'],
  ['steel|SS400:flatBar:FB 125×32', 'bb220911d7178dd00f94b167f95736c0b6a06950083b996f6a0b62923f32f8d4'],
  ['steel|SS400:flatBar:FB 150×32', '94a60669bf4f87be7265d279467f37ffc8e9e0caa5d85e773fc491b887d86ee6'],
  ['steel|SS400:flatBar:FB 200×32', '9f6fa77b5e83b4d3750a442282a8ade3fc8976255e5441cb12fc4f292b8aa3c9'],
  ['steel|SS400:flatBar:FB 25×36', '4e55c9950165f0973257148088a8c077ee33462ac508360f63a23b6f86af360f'],
  ['steel|SS400:flatBar:FB 32×36', '1a98a0cb75ed5f77e18cc4bdac912958a5af8b121c22f4ee3511ea989e0f2ca3'],
  ['steel|SS400:flatBar:FB 38×36', 'fca58818057e181b443263a743432b199f7558606a9c4cf426a5ae48d79ba8e5'],
  ['steel|SS400:flatBar:FB 44×36', '0dcc316f723620bd61b8e6e5b47549e8c64ae9ef580b85a4ffcb7c78f2e28b84'],
  ['steel|SS400:flatBar:FB 50×36', '135398d23744ad106f43d992967c2f8bb10c605d4038a967c9e14fda7d58cae4'],
  ['steel|SS400:flatBar:FB 65×36', '7b67e398821c99cb7ebcc6860843a3111dd5a63c9a6c0faf5cdfd8fb7d24ff5c'],
  ['steel|SS400:flatBar:FB 75×36', '0f255bf602bfeb4fa272a678562cc2177678009943736e906923ff7739e53725'],
  ['steel|SS400:flatBar:FB 90×36', '89fac08293919ce273b6b8d63fc97db73be60ef7abfb981290ef3c1d30573ef2'],
  ['steel|SS400:flatBar:FB 100×36', 'd0362b9038a4a1ffb5be503fe98af42126a5597bd4e35d4cbb9794b22f566e47'],
  ['steel|SS400:flatBar:FB 125×36', 'ca361fcaea0e2bdea168e6fd8b16e2da31052d00df31bd92d2e8ad1aebbcb97a'],
  ['steel|SS400:flatBar:FB 150×36', '2e01eb2156b4186dd95e58301a7d9e439421f9cdd03ac4f8b8895d853900a914'],
  ['steel|SS400:flatBar:FB 200×36', '549953368be08a33c067607d944a4b893f83949c643808313db83d63007de229'],
  ['steel|SS400:roundBar:φ5.5', '5dab1eb9740cadbb6dc8c33556d21d29234f74508e326791e8afd57e7b0b2030'],
  ['steel|SS400:roundBar:φ6', '680af477730659dc072ffc5a130b0086bc12ff3e37c73ed9adf06b89acd6d32c'],
  ['steel|SS400:roundBar:φ7', 'a1f262c37a178494cec00f4bd14d3630c3adf9281c3b99e2c48a7e061d1552a8'],
  ['steel|SS400:roundBar:φ8', '25aef84a7946be5d3195bce0e9e252040a0a32b33a96c411743d5ae266f0cf5d'],
  ['steel|SS400:roundBar:φ9', 'eabdf161bb885a52c66afc8850adae6d4ae076c52c1d1510e3a3f04b64adfc16'],
  ['steel|SS400:roundBar:φ10', '0d3fc370ad1cb0a479ec5154779321d4eccb2616f53d0ca5755577aef5a6ded7'],
  ['steel|SS400:roundBar:φ11', 'b9e83e5cfb0a0ab0cbac70cebbbc6b64b21bf101afff9ce7bf5fcc2c6066ce69'],
  ['steel|SS400:roundBar:φ12', '1d0e6df21896251d06c0de29bbfe8b8ab27f92aa451285c39acfff9d7378a292'],
  ['steel|SS400:roundBar:φ20', '45b12ddff6467d0a5415ab8112756cc3aa0e2d60f40b71ee579e1502333d7cc6'],
  ['steel|SS400:roundBar:φ24', '86eb4b94ef004d92def598483861706d938da4af6654a73660167a317a2f241d'],
  ['steel|SS400:roundBar:φ28', '45cd138321979ae615dd1de6249ebd39d0c26f270c11b20d054b007a813609c6'],
  ['steel|SS400:roundBar:φ30', 'ca63fada2eb9f90e89ca53b68ae8f2f03fba3e4b379420a0a667d57bb3e4a867'],
  ['steel|SS400:roundBar:φ32', 'f63baebd962013206dcb2bec08bce5fdefc8dc92da175c6322529a4056d65370'],
  ['steel|SS400:roundBar:φ36', 'cc56eaec84a323022f7dd3ea1f4570a6c4976085193adebc9ebc63ef5eb5ff18'],
  ['steel|SS400:roundBar:φ38', 'a0e240058c6a6c0cfea0ec8a48a445caed53a986386a83b5978fe0dc755ddf95'],
  ['steel|SS400:roundBar:φ42', 'aa83ea5a27adbc47048e554a5ee3208075d9e5d80d656b3f9592404de76cfa10'],
  ['steel|SS400:roundBar:φ46', 'd978b17cf579d38735f1aad037622dce22f090a8c0b47bf9c46db53f98429a2c'],
  ['steel|SS400:roundBar:φ48', 'b9d4244499ca9b209c52cc1f9e9ccbf0964d5c21eb2d685d45ea55102c2765c7'],
  ['steel|SS400:roundBar:φ50', '2a65e5ce7bff5b1b1335f602e3742a189b24bd1e5198d69ecc0195b275877b0e'],
  ['steel|SS400:roundBar:φ55', 'd7c1c56b162563870183cd06f73223565e7670e4f0bbad743c7fff35ca98ac7c'],
  ['steel|SS400:roundBar:φ56', 'cc98db09d6b69017ec3a49a4822161666d4ca9ab5ddad0dad8de2f91167ac552'],
  ['steel|SS400:roundBar:φ60', '8af38d24e8047a7d8d2444e68caabbf908d12a1ee4ef7ef2a7938c8643f4aa13'],
  ['steel|SS400:roundBar:φ64', '4dcb9995edbed65d4eb4234afc4c2392a50f17917b909c82c9f35504c1251703'],
  ['steel|SS400:roundBar:φ65', '86baa8fb6d38d1dba5b1cc0186489789de1e9a0d15dc34822c9768226166f5f2'],
  ['steel|SS400:roundBar:φ70', '71d9bb2034b99885fe7a98b9b57f92a268f32e72c6f7d887698b3df57b109561'],
  ['steel|SS400:roundBar:φ75', '592b9930355863aece038aae9cf461b221c04ec988c9d88f19fe5df7248a60e7'],
  ['steel|SS400:roundBar:φ80', '273b5baf8c433bcb61c795bc4f983ffbfda1fa706230ad1500dad595e9483eed'],
  ['steel|SS400:roundBar:φ85', '5b2ab2374bf08ddc624f938b5a33126e406adeb0b43fec4e6a8a86eb9a5ece01'],
  ['steel|SS400:roundBar:φ90', '7e14fcb7330e796e31c32d8c7d38f3963438ca3d79cc778f4723be6186a192be'],
  ['steel|SS400:roundBar:φ95', 'c53d0db1a1f2046af77b5e4854e93334c51bae9df76cc3a51887eab421b5cb08'],
  ['steel|SS400:roundBar:φ100', '6d32b6456297165c22463a33c5e01103064924bc201234e58c81be985527f81b'],
  ['steel|SS400:roundBar:φ110', 'cc73db9b4e4e9304662e6d31fbb93574e650ccb32e6aad931e32ce3e3a034137'],
  ['steel|SS400:roundBar:φ120', '91c603aff6af33b10d9a1580af03f0cf9e38a56de3ffee3278daf95f544c90c2'],
  ['steel|SS400:roundBar:φ130', '6d6a3795117065ba0dc1f56a2959c7555c2cfa0fc443977e6b0087c91df1e556'],
  ['steel|SS400:roundBar:φ140', '9fa486a23412389fb3d166697fa5b504e8ea730704060bad7c9a1b58ce7e16f3'],
  ['steel|SS400:roundBar:φ150', '65cbb4a8562325aa0184ee07df41afc62d528399a616984bb352cf6260452216'],
  ['steel|SS400:roundBar:φ160', '27cd3b050c5d85f227cf980a005ed9b284dfe5a27e286937a1e915632f007d0d'],
  ['steel|SS400:roundBar:φ180', '3d0294d9e92e24bad8a19e989280e274057a29eb5b94a6b4b5409cc90f8fdd0a'],
  ['steel|SS400:roundBar:φ200', '6387d4a6942ea0946a8717ecb2bc7251a9f8e8d331d74a17ab60ded2602db50a'],
  ['steel|SS400:equalAngle:L 120×120×8', '0cd2cfd8fc4d697fea056952df152618427cfccbbc8a0588f57b56e84d5a1b42'],
  ['steel|SS400:equalAngle:L 130×130×9', '850a08ef0a6b0519721b8fdca3519bcc8ed9db160e0f6ff8ff731432b0d6c75b'],
  ['steel|SS400:equalAngle:L 130×130×12', 'db9998926f40468eb181452d44ed1fff3b47b5f1a0af5ec673f45e20f5c682bb'],
  ['steel|SS400:equalAngle:L 130×130×15', '9fe5707f37def83515ca525d95c3e6a163915aee97a5ff5e5a88bf37376de29b'],
  ['steel|SS400:equalAngle:L 150×150×12', 'b12e4b933d6c669d6e6b6427a1e11082f8815ad952e4dc8cab742de230fbc68c'],
  ['steel|SS400:equalAngle:L 150×150×15', '4ec81ab6bd0d0bbf15503f3a3b85df82ff743ea6ba2d00f190a0e7447c1cbc3d'],
  ['steel|SS400:equalAngle:L 150×150×19', '74b75592d5f225208be17dc7fccad33a1b7736da9b992cba8283ec8eebf45bd0'],
  ['steel|SS400:equalAngle:L 175×175×12', '9e274adeda10a6c5650257d886b5a20f3b70c6bddf10b2451bcedfcfd35f75ef'],
  ['steel|SS400:equalAngle:L 175×175×15', '598353b450ffadb5c3d2f3876cccf3d48ea36e061e167255e468e4b5dac018d9'],
  ['steel|SS400:equalAngle:L 200×200×15', 'b8dbaea2c126d54d4fb69cc3063d3c845e9fec7a4ec379797ccacdfea2744a32'],
  ['steel|SS400:equalAngle:L 200×200×20', 'a8e1248315d9010ce9404e3e9a192d51c4221e4fad1546907d11fe05d324b992'],
  ['steel|SS400:equalAngle:L 200×200×25', '33266c4efbe4a49b683fce3df33ed17630e2af596516cdcfeb8e3cd89f694e93'],
  ['steel|SS400:equalAngle:L 250×250×25', '8e6d9c22cd730ad33548456529a308c813350cb360656da60fe22593194e74d9'],
  ['steel|SS400:equalAngle:L 250×250×35', 'bae40069ee975978abdcb10661b485428dd4e7a3bae2ef69759a84e06a653ed5'],
  ['steel|SS400:channel:[ 250×90×9×13', '0497dc7c6701624db73b752868eb97a7d76f20dacf1af565ee0eabd26ac8145c'],
  ['steel|SS400:channel:[ 250×90×11×14.5', '35d6164400e38522ef2ba56362ec89aa28f16caa2c4508786755cb79f0a98879'],
  ['steel|SS400:channel:[ 300×90×9×13', 'c01fbdbf870c1ca1abf3410f0c9a5ab69d0e8f70d9fce895015f70668d807048'],
  ['steel|SS400:channel:[ 300×90×10×15.5', 'afe9324ffb48e23dd31a9f2b2e81e2e6c79663f8ef88768a2be3e8297a41d127'],
  ['steel|SS400:channel:[ 300×90×12×16', 'c80e738114af8044a864147c4f551bd06fc9711aa287079284b73f221216bef9'],
  ['steel|SS400:channel:[ 380×100×10.5×16', '2be32298f2a44d7c964eaa1b0641dffd53873bce6ba9938846016a8ca8830085'],
  ['steel|SS400:channel:[ 380×100×13×16.5', '836b5eae270269ceb8a974a58052db0a23c7c6e5a45a73d31f524e1e585d2031'],
  ['steel|SS400:channel:[ 380×100×13×20', '8b5900a2ea337bf6cf5e3bf380e5a09edd36dbf204809fd75e2a8113d575b6a6'],
  ['steel|SS400:hBeam:H 100×50×5×7', '8d60d5f530b84394dcdf9919efefe20be561a67c9cb1a887abe4860b04396746'],
  ['steel|SS400:hBeam:H 125×60×6×8', 'f2ac3dd1937f2240b968daf220f936e1f03c43b855a8c031971f3a032b7f750b'],
  ['steel|SS400:hBeam:H 150×75×5×7', '39ca224eed005a103f8f1f8a23714eaf0700dd424f0cb3331511023e88924d11'],
  ['steel|SS400:hBeam:H 148×100×6×9', '21e6141a60a0d5b54edd6e024b5d4c1eea2c09f092d739b6a5d95478e85e2cf5'],
  ['steel|SS400:hBeam:H 175×90×5×8', 'fb347f651e5cb7f3b962277298be876b8830bc8fc20d1134aa0556dfec850e22'],
  ['steel|SS400:hBeam:H 198×99×4.5×7', '6594dfbd4ed5f47aa921c06e204924928452019d3f6b8b401d42fea712fd0893'],
  ['steel|SS400:hBeam:H 200×100×5.5×8', 'a2d2ef611ee208eae55bdb5450fd5f651c9006f0f340289e541a31135e5f8736'],
  ['steel|SS400:hBeam:H 194×150×6×9', '170e3ad911fa7e90b62097a10ec62f506a22d14f04ed148e75d944895eb92b54'],
  ['steel|SS400:hBeam:H 248×124×5×8', '76c21ad4326955c0435bcf7779cdc8a598ca0b1fb39087e8139345814166e5a0'],
  ['steel|SS400:hBeam:H 250×125×6×9', 'd7c2906680a31e725fdb8897e54b2e1d9b21f8fe83834bd81cdf4dc295473dca'],
  ['steel|SS400:hBeam:H 244×175×7×11', '5f7fd980b1a14efa238a9a628bfdb5ff6e3cd46e81894c1b17c0fef784f3c5c5'],
  ['steel|SS400:hBeam:H 298×149×5.5×8', 'c3f311d5a15744dec21fa275e96c101dd8b3e6938d1079ce01d50c0224bebe7a'],
  ['steel|SS400:hBeam:H 300×150×6.5×9', 'efb5add87c1fc66cd14c98629558acbca5120220cad641c41bd14391a2c8ad58'],
  ['steel|SS400:hBeam:H 294×200×8×12', 'a4858b0d3aa8b23364d6ae1957d0276b9f1b40f1d2c27934b1f0d95284634c26'],
  ['steel|SS400:hBeam:H 346×174×6×9', '7aef569087e3200faac0a589dbd9d2c2845bb21875394bfe76dbebb1eee22d21'],
  ['steel|SS400:hBeam:H 350×175×7×11', 'b59586db0df0963829702d4c260ee6f0162bad1f80ee66a501d0c39a2ec361c2'],
  ['steel|SS400:hBeam:H 340×250×9×14', 'a9d0b93024a9faf82d382d666ba161af6d82b43aec0a156f3da2af31b0345c97'],
  ['steel|SS400:hBeam:H 350×350×12×19', 'f511fec525212b042135c6f1733029e16dbdedc730e9d4109a598f0dda729c79'],
  ['steel|SS400:hBeam:H 396×199×7×11', '8ac14cb9f0a41bd9d4fb656c63bf3544db74473dad057684459f7872af026eba'],
  ['steel|SS400:hBeam:H 400×200×8×13', 'baba5362d9f3426444a2f4cb60e64a86737e616ce8a9db53ed3fd6a0eef43a52'],
  ['steel|SS400:hBeam:H 390×300×10×16', 'cdb2684a4de75e264797b6800a53264a7014c9f79eb9d9d0815a9d0f88dd5bc0'],
  ['steel|SS400:hBeam:H 400×400×13×21', '4176c80467f8e5e40a311631bacde09cb8c0383f8ef04579d9b3ed5cd94c83b3'],
  ['steel|SS400:hBeam:H 414×405×18×28', '9be4f51e5624241375ff4c0b0181de6019e75df9754aea211c69828d09517ced'],
  ['steel|SS400:hBeam:H 428×407×20×35', 'c1a24817f55b2279eccfd4e568c7a304178f9b2e5d88f548cfcde2c80cddfb99'],
  ['steel|SS400:hBeam:H 458×417×30×50', 'f86c109dabe877c01bf222e3864b0147b4d77bb02e97ec4a7dcd821c44d579f3'],
  ['steel|SS400:hBeam:H 498×432×45×70', 'cd468cba95d3b71bf61a9454f874e1d3d9a3edf0846836c8317e08f29166c903'],
  ['steel|SS400:hBeam:H 446×199×8×12', 'da4adac24574eb4012086f76b6aeedec333470a1c005eb1bf5b55862d553b6b0'],
  ['steel|SS400:hBeam:H 450×200×9×14', '98e2af371c75bb5934e4eac280904ed779f5ee985e1c9b451617056fb97ea2e9'],
  ['steel|SS400:hBeam:H 440×300×11×18', '8549039be0092ac0a58c60048c711c3616b0a16f2e1b382c01c11c3ff99b59b1'],
  ['steel|SS400:hBeam:H 496×199×9×14', 'c62d637b7b4997eb961fc66ac39ee2633b2748a11d1b517bf32f221a19e6fd1c'],
  ['steel|SS400:hBeam:H 500×200×10×16', 'e44c6c37a8190ae540368ceff05af1e00caef435486552a053ec80a8634167e8'],
  ['steel|SS400:hBeam:H 482×300×11×15', 'b6045ab626708e3d30073a7395f34167ec1ccec6be82c9117aff32f0d2d6ded6'],
  ['steel|SS400:hBeam:H 488×300×11×18', '88877045dacb5e22f616435491248cc34a99b1c27e5a40d73f492384d4dc9022'],
  ['steel|SS400:hBeam:H 596×199×10×15', 'ae430382194c0332f74f6f72e712b234be164f8dde4eb281287286124d7273b1'],
  ['steel|SS400:hBeam:H 600×200×11×17', '51fb2bab8987679a757e3d64acd7f4a2e5be0aaeb054f684a595ffb5b835c677'],
  ['steel|SS400:hBeam:H 582×300×12×17', 'ff534b8ff020eb4db22d3b8fc48828f1bacb641be458be37223c4979e90a9628'],
  ['steel|SS400:hBeam:H 588×300×12×20', '27f25e88ee7e0b476903c64a674f0687dfee0816376c4d81af7d7ce62ef9b5a6'],
  ['steel|SS400:hBeam:H 594×302×14×23', '64afd717a9e9a7126c890a0323f89fa4031871e915041d6c3761198a8d127813'],
  ['steel|SS400:hBeam:H 692×300×13×20', '7086714415557518ab49a7209940c839106b4fb18989e2ba64c01307ee5b97e9'],
  ['steel|SS400:hBeam:H 700×300×13×24', '5c2b0b84621f3ee7639cbb96a989affbc0c4af29bcb288644319eabaf406bc5a'],
  ['steel|SS400:hBeam:H 792×300×14×22', '183a036b2b7e4c570b482358208304ac6a49638f49a5d2fe2c48ccaaf2b9255e'],
  ['steel|SS400:hBeam:H 800×300×14×26', '27793b7d52438ea10021c0f63f1eea16e5fa16bef0a81038bbff2f5eb16ac12c'],
  ['steel|SS400:hBeam:H 890×299×15×23', 'a767fb83787938b88d241712e7e2a6aec57db76125bed5975bbfe63febdf5f3a'],
  ['steel|SS400:hBeam:H 900×300×16×28', '0da53f6cf9f798329cba9b0eefd232d2044629895ec43ccd032fdefa6cc0f1ca'],
  ['steel|SS400:hBeam:H 912×302×18×34', 'd8aa5447a3c302db793601bfe7acdb6ac07bd63ad071594533036f346d5fd124'],
  ['steel|SS400:hBeam:H 918×303×19×37', 'bb267c858be7cba1f4cb79e59d09a9ceb199a7fda1244bcd06e44da2d2e2a6ce'],
  ['steel|SGP:steelPipe:6A', '46aec440d0eb6dd5229b5f5a78df491ab3649d999c74707207e06dd2525cd9b4'],
  ['steel|SGP:steelPipe:6A:whitePipe-zincCoated', 'ca14b214b9b5b6d773ad1c52cc589d2e4bc9daa1e8f82e86b7427d29dffde638'],
  ['steel|SGP:steelPipe:8A', '2bf4b7067a57149f23d568f6dbb8307b59fc32cd4a488131171e3f2b44afd8b1'],
  ['steel|SGP:steelPipe:8A:whitePipe-zincCoated', '32d48776c911f48b228c9cbe654769e469c3aa12e614ad2cc07e6cf02e88d48e'],
  ['steel|SGP:steelPipe:10A', '5ec6bdf7b96e6ae7b72d589f1a9e07de351a6a34943dad10f55f8482952d2b86'],
  ['steel|SGP:steelPipe:10A:whitePipe-zincCoated', 'c4af1536bbe646d47f71f2b077e18dea004a776942d0ae598dacc5111992bd55'],
  ['steel|SGP:steelPipe:15A:whitePipe-zincCoated', '14cb598c7d7d261d66413c0f870e316098b771afc343ae7957eacdbd1d57badd'],
  ['steel|SGP:steelPipe:20A:whitePipe-zincCoated', '7ef97e2898a201b675f6279849000d79e96f86aa7526f5bd16a6f549ef1de2ce'],
  ['steel|SGP:steelPipe:25A:whitePipe-zincCoated', '7f8a04bdbd85496377bf31d1fbb7802e947b0837ec862c4c97bfd87c55e9cde7'],
  ['steel|SGP:steelPipe:32A:whitePipe-zincCoated', 'd9409a79448a40279d2d9d9ebbf8ef6a2540a56bba2d4dc7875618fa73a226e2'],
  ['steel|SGP:steelPipe:40A:whitePipe-zincCoated', 'e0ca401df5b3901aa92caab8629b14d2d00cbf356bea65ebb805facbd57c7a6a'],
  ['steel|SGP:steelPipe:50A:whitePipe-zincCoated', '8321f9e05993e7ad933feb89d1fb98b04509f30cdd9e7ade4f6717603d990f6a'],
  ['steel|SGP:steelPipe:65A', '84a6351c4c4833ceeb0022fea28c06eafef6444a3de14fb74dc22ee2eba40e68'],
  ['steel|SGP:steelPipe:65A:whitePipe-zincCoated', '374c6e464c821556793d6db5e640fd831656b21b15c13c48742763e66cedf4d2'],
  ['steel|SGP:steelPipe:80A', 'e0659b958536768d6a8193500d39c91777fa2ab51bb0f2bdc92bf46c82abf76b'],
  ['steel|SGP:steelPipe:80A:whitePipe-zincCoated', 'e858371d4e2fa933c6595af9705ac7d2e3bfcbcd5ee65c03869f3bec9dcbc066'],
  ['steel|SGP:steelPipe:90A', '543e3a728c24c89ac1fd1b6c32ff80f480cdaa8927c33701107830343ac71881'],
  ['steel|SGP:steelPipe:90A:whitePipe-zincCoated', 'dec3eb1f36f9dd7f1a527db71da09268da78f298cef976e6f0b5729de3f9bc38'],
  ['steel|SGP:steelPipe:100A', 'f7efab0db48af341a8c3e7f01d6b2b33dcff538a9655c27656b6c173684457f3'],
  ['steel|SGP:steelPipe:100A:whitePipe-zincCoated', '9aa264340255a2b0474a383167f638b8cb729d7571cc401c214293ebcc16e9c1'],
  ['steel|SGP:steelPipe:125A', 'e137654dbd586bb53492258b908dca76c7874b340e701b85f63f831ece3e6b82'],
  ['steel|SGP:steelPipe:125A:whitePipe-zincCoated', '2f47347b672c2488e1cb55cdcf5ac51ce201f79c2c267a60206bb8d76c8b55af'],
  ['steel|SGP:steelPipe:150A', 'a442107522066ccc2dadfd107cc702f5b2f1aad9b7f39e5a451adc1d6a2b125b'],
  ['steel|SGP:steelPipe:150A:whitePipe-zincCoated', '5a84090a5a5d59f53d72bbed967a1beab1f3b47e00a9fa184f05521a5842fa17'],
  ['steel|SGP:steelPipe:175A', 'cfd8e23f6fc84f03a8c1dc8bf6ff88592615c12c756508d461999c7ca2c4a3d0'],
  ['steel|SGP:steelPipe:175A:whitePipe-zincCoated', 'f86787ea9bc8dd868538c9b77544c1acf60c6286e40fe76381ae1b159b857d01'],
  ['steel|SGP:steelPipe:200A', 'a602c9508c32c9b989bcb12809d5e70b175f7addfe7d171c314f3b64338638a2'],
  ['steel|SGP:steelPipe:200A:whitePipe-zincCoated', '2b45f0f253301ca416bd7026cf305e6b493631066dcb488e0f03ccb0c1942cc0'],
  ['steel|SGP:steelPipe:225A', '6df9925d14586135206b5dfa56bc82820873e43c5e9c7f1630ea407c2f4d2ac2'],
  ['steel|SGP:steelPipe:225A:whitePipe-zincCoated', '87ee1ebbbb4ed4e45499574f0056bfd9a4127cec622e67057c9d98d0693ea1cf'],
  ['steel|SGP:steelPipe:250A', 'eb5fdc128a4a7bee7999aede38090a4cdb184e1589c84db0ef7a5c4cba24244d'],
  ['steel|SGP:steelPipe:250A:whitePipe-zincCoated', '752448201a1ff636bb6e4ba767b6d4b34499bb1efef51cbf4ef4a46a42e2d38d'],
  ['steel|SGP:steelPipe:300A', 'a9c5fab79d46441cccc2514fa45bca961441589f7ade2c1886be0e53698170eb'],
  ['steel|SGP:steelPipe:300A:whitePipe-zincCoated', '1fe9ef60e8f52fbb58ecfc860aa063fc5ee3e40b8d38243c232133c4b123e61d'],
  ['steel|SGP:steelPipe:350A', 'c082071656609c2c63a679eaeb85956de4a187c0cc6ca979a1213d4d89894096'],
  ['steel|SGP:steelPipe:350A:whitePipe-zincCoated', 'bad55bb02817e3332d989c4b04abfb6278c87d917caaf3b66c2bfa20914a0e4b'],
  ['steel|SGP:steelPipe:400A', '9db06b2c636ee2b0726dd07d4a6c3b94db5b676944399dcad94a02323b1767ff'],
  ['steel|SGP:steelPipe:400A:whitePipe-zincCoated', '5c003a11a8fccaa080e9e18f151f8e451e22f33b3914969539595d3371e4fae1'],
  ['steel|SGP:steelPipe:450A', 'bba0e35fc4dc9da6e6a0a6a23d3a8650a1e79c6f5e551964a9b025863bdfa40a'],
  ['steel|SGP:steelPipe:450A:whitePipe-zincCoated', '978172f463dd5e4220365ecd6e37701fc4f00d5c5e3d493bbc664e7631dd9473'],
  ['steel|SGP:steelPipe:500A', '9dc0408e1795819e61f07c0348573d0437b1c63901bcc8a1c299abca86d41222'],
  ['steel|SGP:steelPipe:500A:whitePipe-zincCoated', '4cad9e000e96e42261cc9f974e2d4575af04e5d273e7a2eda8f58e6ee76ba9c9'],
  ['filletWeld|2x3|straight', '5e7010fe68e52cdd07b03e9af041e03565fdf0992b6fe41b405d121d1d3c2f67'],
  ['filletWeld|2x3|oblique', '8522a2be6c0df61f5a8bd7fd2a9a6a07b3a6674da0df53c4d319ad55b0a2dd78'],
  ['filletWeld|2x3|cylinder', '4b1d7adb6745e842f3cbc770e64c673215d27d9c4e410e7ce6a40cf8e735b155'],
  ['filletWeld|2x3|innerCylinder', '888b3a63cf5fa91fdeacdc84d3186ba4ec4b1082cf5ea664fac93173cb8801c0'],
];

describe('K0 (c) 既存の形のファイルは、族の登録口を入れる前と同じバイトで読み書きされる', () => {
  const inputs = legacyInputs();
  const byLabel = new Map(inputs.map((input) => [input.label, input]));

  it('凍結の表は 726 件で重なりが無く、どの行も今の表から同じ鍵で作れる', () => {
    expect(FROZEN_SAVED_SOURCE_SHA256).toHaveLength(726);
    expect(new Map(FROZEN_SAVED_SOURCE_SHA256).size).toBe(726);
    expect(FROZEN_SAVED_SOURCE_SHA256.map(([label]) => label).filter((label) => !byLabel.has(label))).toEqual([]);
  });

  it('726 件を置いたアセンブリで、ファイルの中の出どころの JSON が凍結の表と一致し、JSON と ZIP の読み書きのバイトが一致する', async () => {
    const frozen = FROZEN_SAVED_SOURCE_SHA256.flatMap(([label, digest]) => {
      const input = byLabel.get(label);
      return input === undefined ? [] : [{ label, digest, source: createStandardPartSource(input.catalog, input.size, input.options) }];
    });
    expect(frozen).toHaveLength(726);
    const document = assemblyOf(frozen.map((row) => row.source), 'Legacy source freeze');
    const saved = savedSourceTexts(writeAssemblyDocument(document, SAVE_OPTIONS));
    expect(saved).toHaveLength(726);
    const changed = frozen.filter((row, index) => sha256(saved[index]) !== row.digest).map((row) => row.label);
    expect(changed).toEqual([]);
    expect(saved.filter((text) => text.includes('catalogItem'))).toEqual([]);
    for (const reopened of await reopenBoth(document)) {
      expect(savedSourceTexts(writeAssemblyDocument(reopened, SAVE_OPTIONS))).toEqual(saved);
    }
  });

  it.each([
    'hexBolt|M8|annexJA/coarse/30', 'hexNut|M8|annexJA/coarse', 'deepGrooveBallBearing|6000|default',
    'equalAngle|L 50×50×6|unspecified/1000', 'steel|SS400:flatBar:FB 50×6', 'steel|SGP:steelPipe:15A',
  ])('%s: 組んだ部品の .pcad を読んで書いたバイトが一致する', (label) => {
    const input = byLabel.get(label);
    if (input === undefined) throw new Error(`Missing representative ${label}`);
    const part = buildStandardPartFromSource(createStandardPartSource(input.catalog, input.size, input.options));
    if (part === null) throw new Error(`Representative did not build: ${label}`);
    const bytes = writePcadFile(part, SAVE_OPTIONS);
    const reopened = readPcadFile(bytes);
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(writePcadFile(reopened.document, SAVE_OPTIONS)).toEqual(bytes);
  });
});

describe('K0 (b) 族の部品(catalogItem)は読めて、同じバイトで保存し直せ、知らない族は黙って消さずに型付きの拒否になる', () => {
  // 保存の形は model の createCatalogItemSource と同じ。K0 の製品の登録口は族を持たないので、この族は「知らない族」。
  const saved: StandardPartSource = { kind: 'standardPart', catalog: 'catalogItem', size: '2',
    options: { family: 'jis-b-1354-parallel-pin', item: 'jis-b-1354:d2', length: '12' },
    catalogRevision: 'jis-b-1354-2026-11-r1', generatorRevision: 'pin-1' };

  it('ファイルの中の出どころは決まった形で、JSON と ZIP で読んで書き直したバイトが一致する', async () => {
    const document = assemblyOf([saved], '族の部品');
    expect(savedSourceTexts(writeAssemblyDocument(document, SAVE_OPTIONS))).toEqual([
      '{"kind":"standardPart","catalog":"catalogItem","size":"2","options":{"family":"jis-b-1354-parallel-pin",'
        + '"item":"jis-b-1354:d2","length":"12"},"catalogRevision":"jis-b-1354-2026-11-r1","generatorRevision":"pin-1"}',
    ]);
    for (const reopened of await reopenBoth(document)) {
      const source = reopened.components[0]?.source;
      expect(source).toEqual(saved);
    }
  });

  it('知らない族は解く時に部品を作らず理由を出し、開き直して保存しても出どころを消さない', async () => {
    const legacy = createStandardPartSource('hexBolt', 'M8', { length: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse' });
    const document = assemblyOf([legacy, saved], '族と従来の部品');
    for (const reopened of await reopenBoth(document)) {
      const source = reopened.components[1]?.source;
      if (source?.kind !== 'standardPart') throw new Error('Expected the saved catalog item');
      expect(standardPartRejection(source)?.code).toBe('unknown-family');
      expect(standardPartRejection(source)?.message).toBe(UNKNOWN_FAMILY_MESSAGE);
      const before = structuredClone(reopened);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.parts.size).toBe(1);
      expect(resolved.errors.map((error) => [error.componentId, error.message]))
        .toEqual([[reopened.components[1]?.id, UNKNOWN_FAMILY_MESSAGE]]);
      expect(reopened).toEqual(before);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(writeAssemblyDocument(document, SAVE_OPTIONS));
    }
  });

  it('知らない catalog の値は今までどおり読み取りで断る(新しい値は catalogItem の 1 つだけ)', () => {
    const text = writeAssemblyDocument(assemblyOf([saved], '族の部品'), SAVE_OPTIONS).replace('"catalogItem"', '"catalogItems"');
    const result = readAssemblyDocument(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalidField');
    expect(result.error.message).toContain('source.catalog');
  });
});
