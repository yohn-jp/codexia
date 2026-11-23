export interface FloatingPanelLayout {
  panelId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
const panelIdPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,159}$/u;
export function validateFloatingPanels(value: unknown, knownIds: readonly string[], hiddenIds: readonly string[]): value is FloatingPanelLayout[] {
  if (!Array.isArray(value) || value.length > 12) return false;
  const known=new Set(knownIds),hidden=new Set(hiddenIds),found=new Set<string>();
  for(const item of value){
    if(!item||typeof item!=="object"||Array.isArray(item))return false;
    const v=item as Record<string,unknown>;
    if(Object.keys(v).length!==5||!["panelId","left","top","width","height"].every(k=>Object.prototype.hasOwnProperty.call(v,k)))return false;
    if(typeof v.panelId!=="string"||!panelIdPattern.test(v.panelId)||!known.has(v.panelId)||!hidden.has(v.panelId)||found.has(v.panelId))return false;
    found.add(v.panelId);
    for(const key of ["left","top","width","height"] as const)if(typeof v[key]!=="number"||!Number.isFinite(v[key]))return false;
    if((v.left as number)<0||(v.left as number)>10000||(v.top as number)<0||(v.top as number)>10000||
      (v.width as number)<180||(v.width as number)>5000||(v.height as number)<150||(v.height as number)>5000)return false;
  }
  return true;
}
