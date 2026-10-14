// Offline-only OpenAI-compatible llama.cpp endpoint. No remote endpoint, API key,
// subscription routing or model license assumption. The operator must provide a
// lawful and personally audited LOCAL_LLM_MODEL before a real agent run.
export function validateLocalModelConfig({endpoint,model}={}) {
  const match=typeof endpoint==="string" &&
    /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{2,5})\/v1\/chat\/completions$/.exec(endpoint);
  if (!match || Number(match[2])<1024 || Number(match[2])>65535) {
    throw new Error("Loopback-only local LLM endpoint required");
  }
  if (typeof model!=="string" || !/^[a-zA-Z0-9._/-]{1,100}$/.test(model)) {
    throw new Error("LOCAL_LLM_MODEL required after validating model license");
  }
  return {endpoint,model};
}

export function localModelConfig(env=process.env) {
  return validateLocalModelConfig({
    endpoint:env.LOCAL_LLM_URL || "http://127.0.0.1:18080/v1/chat/completions",
    model:env.LOCAL_LLM_MODEL
  });
}

export function createLocalModel(config=localModelConfig(), fetchImpl=fetch) {
  // Validate even when callers supply their own config; no accidental remote
  // endpoint can bypass the environment-only guard.
  const {endpoint,model}=validateLocalModelConfig(config);
  return async ({messages,tools,tool_choice,temperature=0})=>{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const res=await fetchImpl(endpoint,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({model,messages,tools,tool_choice,temperature,max_tokens:256}),
        signal:controller.signal
      });
      if(!res.ok) throw new Error("LOCAL_LLM_HTTP_"+res.status);
      const size=Number(res.headers?.get?.("content-length")||0);
      if(size>262144) throw new Error("LOCAL_LLM_RESPONSE_TOO_LARGE");
      const raw=await res.text();
      if(raw.length>262144) throw new Error("LOCAL_LLM_RESPONSE_TOO_LARGE");
      return JSON.parse(raw);
    }finally{clearTimeout(timeout);}
  };
}
