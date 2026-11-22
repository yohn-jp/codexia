import assert from "node:assert/strict";
import { test } from "node:test";
import { validateFloatingPanels } from "./floating";
const ids=["editor","outline","inspector"],hidden=["outline"];
const example=[{panelId:"outline",left:100,top:120,width:350,height:390}];
test("floating layout validates identity, visibility, geometry and duplicates",()=>{
 assert.equal(validateFloatingPanels(example,ids,hidden),true);
 assert.equal(validateFloatingPanels(example,ids,[]),false);
 assert.equal(validateFloatingPanels([{...example[0],panelId:"foreign"}],ids,hidden),false);
 assert.equal(validateFloatingPanels([{...example[0],width:0}],ids,hidden),false);
 assert.equal(validateFloatingPanels([example[0],example[0]],ids,hidden),false);
});
