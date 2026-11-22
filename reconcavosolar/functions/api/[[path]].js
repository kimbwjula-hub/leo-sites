const J=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const ok=(req,env)=>env.ADMIN_PASS&&req.headers.get('x-admin-pass')===env.ADMIN_PASS;
export async function onRequest({request,env,params}){
  const p=(params.path||[]).join('/'),m=request.method;
  if(p==='ofertas'&&m==='GET'){const v=await env.CAT.get('ofertas');return J(v?JSON.parse(v):{items:null});}
  if(p==='login'&&m==='POST'){const b=await request.json().catch(()=>({}));return b.pass&&b.pass===env.ADMIN_PASS?J({ok:true}):J({error:'Senha incorreta'},401);}
  if(!ok(request,env))return J({error:'Senha incorreta'},401);
  if(p==='ofertas'&&m==='PUT'){
    const b=await request.json();if(!Array.isArray(b.items)||b.items.length>40)return J({error:'Lista inválida'},400);
    const clean=b.items.map(x=>({id:String(x.id||crypto.randomUUID()).slice(0,40),cat:String(x.cat||'').slice(0,40),name:String(x.name||'').slice(0,60),desc:String(x.desc||'').slice(0,120),price:String(x.price||'').slice(0,30),parc:String(x.parc||'').slice(0,40),img:String(x.img||'').slice(0,200),hot:!!x.hot}));
    await env.CAT.put('ofertas',JSON.stringify({items:clean,at:Date.now()}));return J({ok:true});
  }
  if(p==='img'&&m==='POST'){
    const buf=await request.arrayBuffer();if(buf.byteLength>4e6)return J({error:'Imagem muito grande'},413);
    const id=crypto.randomUUID().slice(0,12);await env.CAT.put('img:'+id,buf,{metadata:{type:request.headers.get('content-type')||'image/jpeg'}});
    return J({url:'/i/'+id});
  }
  return J({error:'Não encontrado'},404);
}
