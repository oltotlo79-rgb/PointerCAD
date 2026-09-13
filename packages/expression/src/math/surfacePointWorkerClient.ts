import {BoundedCalculationClient,type CalculationWorkerPort} from './boundedCalculationClient.js';
import {decodeSurfacePointWorkRequest,type SurfacePointWorkRequest} from './surfacePointWorkRequest.js';
import {createSurfacePointWorkEnvelope,type SurfacePointWorkResult} from './surfacePointWorkEnvelope.js';
import {decodeSurfacePointWorkReply} from './surfacePointWorkReply.js';

export class SurfacePointWorkerClient extends BoundedCalculationClient<SurfacePointWorkRequest,SurfacePointWorkResult> {
  constructor(options:{readonly createWorker:()=>CalculationWorkerPort}) {
    super({...options,decodeRequest:decodeSurfacePointWorkRequest,createEnvelope:createSurfacePointWorkEnvelope,decodeReply:decodeSurfacePointWorkReply});
  }
}
