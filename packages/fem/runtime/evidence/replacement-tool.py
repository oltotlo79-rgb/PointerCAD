"""Prepare a caller-pinned local OOFEM replacement without executing its code.

This produces a new isolated package. It does not overwrite the baseline, build
native code, qualify ABI behavior, or assert legal/source completeness.
"""
from pathlib import Path, PurePosixPath
import argparse
import base64
import csv
import datetime
from email.parser import BytesParser
import hashlib
import io
import json
import re
import stat
import zipfile

TAG='cp313-cp313-pyodide_2025_0_wasm32'
BASE_VERSION='3.1.dev5+g214b161ed'
BASE_WHEEL='oofem-3.0-'+TAG+'.whl'
BASE_MANIFEST_SHA='c677e4d7d36a2a3f3caf8bc590a8cfcc892c6445dc9ecd92086b4ab916f24c18'
SOURCE_MANIFEST_SHA='6b228961f2fe4e66aa36f6234b2afcfbbc3d8fc7686d8645a16ea7efb746cbaa'
PREFIX='scratchpad/claude/agents/cx_v103_fem_runtime_astra'
APP_FILES=('assets.ts','beamProof.py','client.ts','offlineBrowser.ts','protocol.ts','runtime.ts','worker.ts')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_pinned(path,expected):
    if not re.fullmatch('[0-9a-f]{64}',expected):
        raise ValueError('Expected a lowercase SHA-256')
    data=path.read_bytes()
    if digest(data)!=expected:
        raise ValueError('Input SHA-256 differs: '+str(path))
    return data

def safe_name(name):
    parts=PurePosixPath(name).parts
    if (not name or len(name)>240 or name.startswith('/') or any(c in name for c in '\\:<>"|?*')
            or any(ord(c)<32 or ord(c)==127 for c in name)
            or any(p in ('','.', '..') or p.endswith((' ','.')) for p in parts)
            or any(re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])',p.split('.')[0],re.IGNORECASE) for p in parts)
            or '/'.join(parts)!=name):
        raise ValueError('Unsafe archive member')
    return name

def inspect_wheel(data):
    if not 0<len(data)<=64*1024*1024:
        raise ValueError('Wheel byte limit exceeded')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries=archive.infolist()
        if not 1<=len(entries)<=10000 or sum(e.file_size for e in entries)>128*1024*1024:
            raise ValueError('Wheel expansion limit exceeded')
        names=[]
        for entry in entries:
            safe_name(entry.filename)
            if (entry.is_dir() or entry.flag_bits&1 or stat.S_ISLNK(entry.external_attr>>16)
                    or entry.file_size>64*1024*1024):
                raise ValueError('Unsupported wheel member')
            names.append(entry.filename)
        if len({name.casefold() for name in names})!=len(names):
            raise ValueError('Duplicate or case-colliding wheel member')
        metadata_names=[n for n in names if n.endswith('.dist-info/METADATA')]
        if len(metadata_names)!=1:
            raise ValueError('Exactly one wheel distribution required')
        folder=metadata_names[0].rsplit('/',1)[0]
        if not folder.startswith('oofem-'):
            raise ValueError('Unexpected wheel distribution directory')
        if any(not n.startswith(('oofem/',folder+'/')) for n in names):
            raise ValueError('Wheel contains another top-level distribution')
        content={name:archive.read(name) for name in names}
    metadata=BytesParser().parsebytes(content[folder+'/METADATA'])
    wheel=BytesParser().parsebytes(content[folder+'/WHEEL'])
    version=metadata.get('Version','')
    if (metadata.get_all('Name')!=['oofem'] or metadata.get_all('Version')!=[version]
            or len(version)>128
            or not re.fullmatch(r'(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?(?:\.dev[0-9]+)?(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?',version)
            or folder!='oofem-'+version+'.dist-info'
            or metadata.get_all('Requires-Python')!=['>=3.11']
            or sorted(metadata.get_all('Requires-Dist',[]))!=['matplotlib','numpy','pytest']):
        raise ValueError('OOFEM identity, Python requirement or declared dependency closure differs')
    if (wheel.get_all('Wheel-Version')!=['1.0'] or wheel.get_all('Root-Is-Purelib')!=['false']
            or wheel.get_all('Tag')!=[TAG]):
        raise ValueError('OOFEM wheel ABI tag differs')
    for name in ['oofem/__init__.py','oofem/oofempy.so',folder+'/licenses/LICENSE',folder+'/licenses/COPYING.LGPLv2.1']:
        if name not in content:
            raise ValueError('Required OOFEM module/license member missing')
    native={name:digest(body) for name,body in content.items() if name.endswith('.so')}
    if not native or any(content[name][:8]!=b'\x00asm\x01\x00\x00\x00' for name in native):
        raise ValueError('Expected WebAssembly v1 native side modules')
    record_name=folder+'/RECORD'
    record={}
    for fields in csv.reader(io.StringIO(content[record_name].decode('utf-8'))):
        if len(fields)!=3 or fields[0] in record:
            raise ValueError('Invalid or duplicate wheel RECORD row')
        record[fields[0]]=fields[1:]
    if set(record)!=set(content) or record[record_name]!=['','']:
        raise ValueError('Wheel RECORD coverage differs')
    for name,body in content.items():
        if name==record_name:
            continue
        encoded=base64.urlsafe_b64encode(hashlib.sha256(body).digest()).decode('ascii').rstrip('=')
        if record[name]!=['sha256='+encoded,str(len(body))]:
            raise ValueError('Wheel RECORD hash/size differs: '+name)
    return {'version':version,'folder':folder,'tag':TAG,'declaredDependencies':['matplotlib','numpy','pytest'],
        'nativeSha256':native,'memberCount':len(content),'content':content}

def contained(root,name):
    path=(root/name).resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('Baseline input escapes source root')
    return path

def replace_once(source,old,new):
    if source.count(old)!=1:
        raise ValueError('Expected exactly one fixed source substitution')
    return source.replace(old,new)

def put(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as stream:
        stream.write(data)

def json_bytes(value):
    return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode('utf-8')

def prepare(root,wheel_path,wheel_sha,source_note_path,source_note_sha,output):
    root=root.resolve(strict=True)
    # All inputs are checked before exclusive output-directory creation.
    if not 0<wheel_path.stat().st_size<=64*1024*1024 or not 0<source_note_path.stat().st_size<=1024*1024:
        raise ValueError('Caller input size limit exceeded')
    wheel_bytes=read_pinned(wheel_path,wheel_sha)
    replacement=inspect_wheel(wheel_bytes)
    source_note=read_pinned(source_note_path,source_note_sha)
    if not 1<=len(source_note)<=1024*1024:
        raise ValueError('A bounded caller-authored source/modification note is required')
    source_note.decode('utf-8')
    baseline=json.loads(read_pinned(root/PREFIX/'candidate/offlineManifest.json',BASE_MANIFEST_SHA))
    source_manifest=json.loads(read_pinned(root/PREFIX/'candidate/browser-r4/after-manifest.json',SOURCE_MANIFEST_SHA))
    if baseline['format']!='pointercad-fem-offline-proof/1' or len(baseline['files'])!=30:
        raise ValueError('Original runtime inventory differs')
    assets={}
    for pin in baseline['files']:
        name=safe_name(pin['file'])
        if '/' in name or name in assets:
            raise ValueError('Invalid fixed runtime filename')
        data=read_pinned(contained(root,pin['sourcePath']),pin['sha256'])
        if len(data)!=pin['bytes']:
            raise ValueError('Original asset size differs')
        assets[name]=data
    original=inspect_wheel(assets[BASE_WHEEL])
    for name in ['LICENSE','COPYING.LGPLv2.1']:
        if replacement['content'][replacement['folder']+'/licenses/'+name]!=original['content'][original['folder']+'/licenses/'+name]:
            raise ValueError('Original OOFEM license text must be preserved')
    application={}
    for name in APP_FILES:
        source_name=PREFIX+'/candidate/browser-r4/packages/fem/src/'+name
        pin=source_manifest['files'][source_name]
        application[name]=read_pinned(contained(root,source_name),pin['sha256'])
    new_wheel='oofem-'+replacement['version']+'-'+TAG+'.whl'
    application['protocol.ts']=replace_once(application['protocol.ts'].decode('utf-8'),
        "export const OOFEM_DISTRIBUTION_VERSION = '"+BASE_VERSION+"';",
        'export const OOFEM_DISTRIBUTION_VERSION = '+json.dumps(replacement['version'])+';').encode('utf-8')
    application['beamProof.py']=replace_once(application['beamProof.py'].decode('utf-8'),
        "distribution_version != '"+BASE_VERSION+"'",'distribution_version != '+repr(replacement['version'])).encode('utf-8')
    application['offlineBrowser.ts']=replace_once(application['offlineBrowser.ts'].decode('utf-8'),
        BASE_WHEEL,new_wheel).encode('utf-8')
    del assets[BASE_WHEEL]
    assets[new_wheel]=wheel_bytes
    assets['beamProof.py']=application['beamProof.py']
    pins=[{'file':name,'bytes':len(body),'sha256':digest(body)} for name,body in assets.items()]
    application['assets.ts']=('// Generated for an explicitly selected local replacement; integrity remains enforced.\n'
        +'export const FEM_ASSETS = '+json.dumps(pins,indent=2)+' as const;\n').encode('utf-8')
    notices={}
    for pin in baseline['notices']:
        if pin['wheel']==BASE_WHEEL:
            continue
        key=safe_name(pin['wheel']+'/'+pin['entry'])
        notices[key]=read_pinned(contained(root,pin['sourcePath']),pin['sha256'])
    for name,body in replacement['content'].items():
        if name.startswith(replacement['folder']+'/licenses/'):
            notices[safe_name(new_wheel+'/'+name)]=body
    output=output.absolute()
    if output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise ValueError('Output must be a new directory with an existing parent')
    output.mkdir(exist_ok=False)
    for name,body in assets.items():
        put(output/'runtime'/name,body)
    for name,body in application.items():
        put(output/'application-src/packages/fem/src'/name,body)
    for name,body in notices.items():
        put(output/'notices'/name,body)
    put(output/'replacement-source-note.txt',source_note)
    now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).isoformat()
    manifest={'format':'pointercad-fem-local-replacement/1','actualTime':now,'qualification':'UNEXECUTED',
        'baselineManifestSha256':BASE_MANIFEST_SHA,'applicationSourceManifestSha256':SOURCE_MANIFEST_SHA,
        'replacementWheel':new_wheel,'replacementVersion':replacement['version'],'replacementSha256':wheel_sha,
        'inputFilename':wheel_path.name,'originalPublicAssetVersion':'3.0','originalEmbeddedVersion':BASE_VERSION,
        'originalWheelSha256':next(p['sha256'] for p in baseline['files'] if p['file']==BASE_WHEEL),
        'originalNativeSha256':original['nativeSha256'],'replacementNativeSha256':replacement['nativeSha256'],
        'nativeBytesChanged':original['nativeSha256']!=replacement['nativeSha256'],
        'nativeRebuildExecuted':False,'correspondingSourceComplete':False,'legalClearance':False,
        'runtimeVersion':baseline['runtimeVersion'],'pythonVersion':baseline['pythonVersion'],'abi':baseline['abi'],
        'sourceNoteSha256':source_note_sha,'assets':pins,
        'files':{path.relative_to(output).as_posix():{'bytes':path.stat().st_size,'sha256':digest(path.read_bytes())}
            for path in sorted(output.rglob('*')) if path.is_file()}}
    put(output/'replacement-manifest.json',json_bytes(manifest))
    return manifest

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--wheel',required=True,type=Path)
    parser.add_argument('--wheel-sha256',required=True)
    parser.add_argument('--source-note',required=True,type=Path)
    parser.add_argument('--source-note-sha256',required=True)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    result=prepare(args.root,args.wheel,args.wheel_sha256,args.source_note,args.source_note_sha256,args.output)
    print(json.dumps({'output':str(args.output),'replacementSha256':result['replacementSha256'],
        'replacementVersion':result['replacementVersion'],'nativeBytesChanged':result['nativeBytesChanged'],
        'nativeRebuildExecuted':False,'qualification':'UNEXECUTED'}))

if __name__=='__main__':
    main()
