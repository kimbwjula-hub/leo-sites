export async function onRequest({env,params}){
  const r=await env.CAT.getWithMetadata('img:'+params.id,{type:'arrayBuffer'});
  if(!r.value)return new Response('not found',{status:404});
  return new Response(r.value,{headers:{'content-type':(r.metadata&&r.metadata.type)||'image/jpeg','cache-control':'public, max-age=31536000, immutable'}});
}
