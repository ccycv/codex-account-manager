(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.Privacy=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function name(account,state,hidden){
    if(!hidden)return account?.label||'Account';
    if(account?.unassigned||account?.id==='unassigned')return 'Unassigned history';
    const i=(state?.accounts||[]).findIndex(a=>a.id===account?.id);
    if(i>=0)return 'Account '+(i+1);
    const j=(state?.localUsage?.accounts||[]).findIndex(a=>a.id===(account?.localId||account?.id));
    return j>=0?'Archived account '+(j+1):'Account';
  }
  function email(account,hidden){return hidden?'Email hidden':account?.identity?.email||account?.email||'Identity unavailable';}
  function redact(value,state,hidden){
    if(value==null||!hidden)return value;
    let text=String(value);
    const labels=[...(state?.accounts||[]),...(state?.localUsage?.accounts||[])].filter(a=>a.label?.length>=3).sort((a,b)=>b.label.length-a.label.length);
    for(const a of labels)text=text.split(a.label).join(name(a,state,true));
    return text.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'Email hidden');
  }
  return {name,email,redact};
});
