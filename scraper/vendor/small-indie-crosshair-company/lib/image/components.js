/** Independent 4-connected component bounds, not a fit to a historical template. */
import { validateMask } from '../geometry/pixel-shape.js';
function adjacent(i, side) {
  const x=i%side,y=Math.floor(i/side),out=[];
  if(x>0)out.push(i-1);if(x<side-1)out.push(i+1);
  if(y>0)out.push(i-side);if(y<side-1)out.push(i+side);
  return out;
}
function flood(start, side, data, seen) {
  const queue=[start];seen[start]=1;
  let minX=side,minY=side,maxX=0,maxY=0;
  for(let j=0;j<queue.length;j++) {
    const i=queue[j],x=i%side,y=Math.floor(i/side);
    minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    for(const k of adjacent(i,side))if(data[k]&&!seen[k]){seen[k]=1;queue.push(k);}
  }
  const w=maxX-minX+1,h=maxY-minY+1,half=(side-1)/2;
  return {minX:minX-half,maxX:maxX-half,minY:minY-half,maxY:maxY-half,w,h,count:queue.length,
    fill:queue.length/(w*h),touchesEdge:minX===0||minY===0||maxX===side-1||maxY===side-1};
}
export function componentBounds(mask) {
  validateMask(mask);
  const {side,data}=mask,seen=new Uint8Array(data.length),components=[];
  for(let start=0;start<data.length;start++) {
    if(!data[start]||seen[start])continue;
    components.push(flood(start,side,data,seen));
  }
  return components;
}
export function axisComponents(components, center = 0) {
  const axis=components.filter(c=>c.fill===1&&!c.touchesEdge);
  const crossX=c=>c.minX<=center&&c.maxX+1>center,crossY=c=>c.minY<=center&&c.maxY+1>center;
  const pick=predicate=>{
    const choices=axis.filter(predicate);
    if(choices.length>1)throw new Error('Multiple native components on an axis: isolate the foreground or adjust the crop.');
    return choices[0];
  };
  return {dot:pick(c=>crossX(c)&&crossY(c)&&c.w===c.h),left:pick(c=>c.maxX+1<=center&&crossY(c)),
    right:pick(c=>c.minX>center&&crossY(c)),top:pick(c=>c.maxY+1<=center&&crossX(c)),
    bottom:pick(c=>c.minY>center&&crossX(c))};
}
export function barGeometry({left,right,top,bottom}) {
  if(!left||!right||!bottom)throw new Error('Native measurement needs separated left/right/bottom bars, or an isolated square dot. Do not fit a synthetic template to ambiguous evidence.');
  const lengths=[left.w,right.w,bottom.h],widths=[left.h,right.h,bottom.w];
  if(top){lengths.push(top.h);widths.push(top.w);}
  if(new Set(lengths).size!==1||new Set(widths).size!==1)throw new Error('Native bars have inconsistent dimensions; anisotropic scaling, outline or segmentation is possible. Use original pixels / manual measurements.');
  const near=-(left.maxX+1),far=right.minX;
  if((top&&-(top.maxY+1)!==near)||bottom.minY!==far)throw new Error('Native horizontal/vertical inner edges disagree; this model family cannot represent the measured centering.');
  return {length:lengths[0],width:widths[0],near,far};
}
