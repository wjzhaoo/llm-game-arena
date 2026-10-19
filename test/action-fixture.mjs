// Existing rule/protocol regressions use a neutral acting choice under the new task protocol.
// Presentation-specific tests submit directly and also cover missing/invalid state values.
export function submitAction(arena,identity,input) {
 const result=input.result&&typeof input.result==='object'&&!Array.isArray(input.result)?{state:'平静',...input.result}:input.result;
 return arena.submit(identity,{...input,result});
}
