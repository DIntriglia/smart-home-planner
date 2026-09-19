import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../src/js/device-form.js", import.meta.url), "utf8");
function setup() {
    const controls = [{id:"name",name:"name",type:"text",value:"Original",dataset:{}}];
    const listeners = {};
    const location = {href:"http://localhost/device-edit.html?id=one",origin:"http://localhost",pathname:"/device-edit.html",search:"?id=one",assign(url){this.assigned=url;}};
    const context = vm.createContext({URL, location, controls,
        window:{location,addEventListener:(name,fn)=>listeners[name]=fn},
        document:{querySelectorAll:()=>controls,addEventListener:(name,fn)=>listeners[name]=fn},
        showConfirm:async()=>false});
    vm.runInContext(`let selectedIspGatewayIds=new Set(), selectedWifiClientIds=new Set(), selectedZigbeeChildIds=new Set(), selectedZwaveChildIds=new Set(), selectedBluetoothChildIds=new Set(), pendingDeviceImageFile=null;\n${source.slice(source.indexOf("let deviceFormBaseline"),source.indexOf("const amazonBatteryMetaMap"))}`,context);
    context.initializeDeviceLeaveGuard();
    return {context,controls,listeners,location};
}
test("unsaved guard detects edits, reverting, dynamic controls and relationship selections",()=>{
    const {context,controls}=setup();
    assert.equal(context.hasUnsavedDeviceChanges(),false);
    controls[0].value="Edited";
    assert.equal(context.hasUnsavedDeviceChanges(),true);
    controls[0].value="Original";
    assert.equal(context.hasUnsavedDeviceChanges(),false);
    controls.push({id:"note",type:"text",value:"new",dataset:{}});
    assert.equal(context.hasUnsavedDeviceChanges(),true);
    context.markDeviceFormSaved();
    assert.equal(context.hasUnsavedDeviceChanges(),false);
    vm.runInContext('selectedWifiClientIds.add("client")',context);
    assert.equal(context.hasUnsavedDeviceChanges(),true);
});
test("beforeunload only blocks unsaved or pending writes",()=>{
    const {context,controls,listeners}=setup();
    let prevented=false;
    const event={preventDefault(){prevented=true;}};
    listeners.beforeunload(event);
    assert.equal(prevented,false);
    controls[0].value="Edited";
    listeners.beforeunload(event);
    assert.equal(prevented,true);
    assert.equal(event.returnValue,"");
    context.markDeviceFormSaved(); prevented=false;
    listeners.beforeunload(event); assert.equal(prevented,false);
    vm.runInContext('deviceSaveInProgress=true',context);
    listeners.beforeunload(event); assert.equal(prevented,true);
});
test("navigation cancellation retains edits; confirmed discard navigates once",async()=>{
    const {context,controls,listeners,location}=setup();
    controls[0].value="Edited";
    const link={href:"http://localhost/devices.html",hasAttribute:()=>false,target:""};
    let blocked=0;
    const event={target:{closest:()=>link},button:0,preventDefault(){blocked++;},stopImmediatePropagation(){}};
    await listeners.click(event);
    assert.equal(blocked,1);
    assert.equal(location.assigned,undefined);
    assert.equal(context.hasUnsavedDeviceChanges(),true);
    context.showConfirm=async()=>true;
    await listeners.click(event);
    assert.equal(location.assigned,link.href);
    assert.equal(context.hasUnsavedDeviceChanges(),false);
});
