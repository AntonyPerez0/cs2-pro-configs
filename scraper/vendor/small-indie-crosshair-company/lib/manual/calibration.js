import { finite, integer, height, text, schemaObject } from '../settings/validation.js';
/** Centered ordinary least squares; observations remain user-supplied, not certified. */
export function fitAffine(points) {
  if (!Array.isArray(points) || points.length<3 || points.length>128) throw new Error('Supply 3–128 observations, including a holdout check where possible.');
  points.forEach(p=>{finite(p.setting,'Setting',0,255);finite(p.pixels,'Measured pixels',-1024,8192);});
  if (new Set(points.map(p=>p.setting)).size < 3) throw new Error('At least three distinct settings are required.');
  const mean=key=>points.reduce((s,p)=>s+p[key],0)/points.length;
  const x=mean('setting'),y=mean('pixels');
  const xx=points.reduce((s,p)=>s+(p.setting-x)**2,0);
  const xy=points.reduce((s,p)=>s+(p.setting-x)*(p.pixels-y),0);
  const slope=xy/xx,intercept=y-slope*x;
  if (!(slope>0) || !Number.isFinite(slope+intercept)) throw new Error('Fit must have a finite positive slope. Check saturation, units and selected measurements.');
  const residuals=points.map(p=>({...p,predicted:intercept+slope*p.setting,residual:p.pixels-(intercept+slope*p.setting)}));
  const sse=residuals.reduce((s,p)=>s+p.residual**2,0);
  const rmse=Math.sqrt(sse/points.length),maxResidual=Math.max(...residuals.map(p=>Math.abs(p.residual)));
  const sxx=points.reduce((s,p)=>s+(p.pixels-y)**2,0);
  return {slope,intercept,rmse,maxResidual,rSquared:sxx===0?null:1-sse/sxx,residuals,
    status:'fit-to-user-input-not-renderer-verification',warning:maxResidual>.5?'Residual above 0.5px: inspect rounding, nonlinearity or mixed measurement conditions.':
      'Small residuals do not prove the model. Test independent settings, thickness parity and both edges.'};
}
export function inverseAffine(fit,target,max=128) {
  finite(target,'Target',-1024,8192); integer(max,'Maximum',1,255);
  const raw=(target-fit.intercept)/fit.slope;
  const candidates=[...new Set([Math.floor(raw),Math.ceil(raw)])].filter(n=>n>=0&&n<=max)
    .map(value=>({value,predicted:fit.intercept+fit.slope*value,residual:fit.intercept+fit.slope*value-target}));
  return {raw,candidates,inRange:raw>=0&&raw<=max};
}
export function validateMeasurement(input) {
  const d=schemaObject(input,['schema','kind','provenance','scope','points','screenshot','notes'],'Measurement');
  if(d.schema!=='sicc-measurement-v1') throw new Error('Unknown measurement schema.');
  if(!['gap-near','gap-far','length','thickness'].includes(d.kind)) throw new Error('Unknown measurement kind.');
  if(!['user-entered','synthetic-example'].includes(d.provenance)) throw new Error('Evidence cannot be imported as verified.');
  const s=schemaObject(d.scope,['build','currentHeight','authoredHeight','effectiveThickness','style','outline','recoil'],'Scope');
  text(s.build,'Build',64); height(s.currentHeight);height(s.authoredHeight);integer(s.effectiveThickness,'Effective thickness',1,128);
  if(s.style!==4||s.outline!==false||s.recoil!==false) throw new Error('Calibration requires static style 4 with outline and recoil off.');
  text(d.notes??'','Notes',2048);
  if(!Array.isArray(d.points)||d.points.length>128) throw new Error('Too many observations.');
  d.points.forEach(p=>{schemaObject(p,['setting','pixels'],'Point');finite(p.setting,'Setting',0,255);finite(p.pixels,'Pixels',-1024,8192);});
  if(d.screenshot!==null&&d.screenshot!==undefined) {
    schemaObject(d.screenshot,['name','width','height','sha256'],'Screenshot');text(d.screenshot.name,'Screenshot name',256);
    integer(d.screenshot.width,'Image width',1,8192);integer(d.screenshot.height,'Image height',1,8192);
    if(d.screenshot.sha256!==null&&!/^[a-f0-9]{64}$/.test(d.screenshot.sha256)) throw new Error('Invalid screenshot hash.');
  }
  return d;
}
