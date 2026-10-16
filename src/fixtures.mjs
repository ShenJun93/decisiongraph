// Clearly synthetic data. Constructed after Graph Hacks opened on 2026-10-15 01:31 ICT.
// Each project shows one way company knowledge can disagree; the graph policy must
// either name a traceable owner or refuse to decide.
export const PROJECT_ID = "orion";
export const SERVICE_ID = "billing-gateway";
export const GRAPH_FIXTURE = {
  projects: [
    {id: "orion", name: "Project Orion", serviceId: "billing-gateway"},
    {id: "vega", name: "Project Vega", serviceId: "ml-pipeline"},
    {id: "nova", name: "Project Nova", serviceId: "payments-api"},
    {id: "lyra", name: "Project Lyra", serviceId: "search-index"}
  ],
  services: [
    {id: "billing-gateway", name: "Billing Gateway"},
    {id: "ml-pipeline", name: "ML Pipeline"},
    {id: "payments-api", name: "Payments API"},
    {id: "search-index", name: "Search Index"}
  ],
  people: [
    {id:"aria",name:"Aria (synthetic)"},
    {id:"ben",name:"Ben (synthetic)"},
    {id:"cora",name:"Cora (synthetic)"},
    {id:"dev",name:"Dev (synthetic)"}
  ],
  claims: [
    // Orion: a newer signed change-control record outranks an older directory entry and a chat note.
    {id:"claim-legacy", serviceId:"billing-gateway", sourceId:"directory-sep", rank:90,
      ownerId:"aria", effectiveAt:"2026-09-20T08:00:00.000Z"},
    {id:"claim-current", serviceId:"billing-gateway", sourceId:"change-control-oct", rank:90,
      ownerId:"ben", effectiveAt:"2026-10-14T11:00:00.000Z"},
    {id:"claim-chat", serviceId:"billing-gateway", sourceId:"chat-note-oct", rank:35,
      ownerId:"aria", effectiveAt:"2026-10-14T16:00:00.000Z"},
    // Vega: HR system of record beats a newer but low-authority wiki edit.
    {id:"claim-vega-hr", serviceId:"ml-pipeline", sourceId:"hr-system-oct", rank:95,
      ownerId:"cora", effectiveAt:"2026-10-01T09:00:00.000Z"},
    {id:"claim-vega-wiki", serviceId:"ml-pipeline", sourceId:"wiki-edit-oct", rank:20,
      ownerId:"dev", effectiveAt:"2026-10-13T10:00:00.000Z"},
    // Nova: two equally authoritative records for the same instant name different owners -> must refuse.
    {id:"claim-nova-a", serviceId:"payments-api", sourceId:"change-control-nova-a", rank:80,
      ownerId:"aria", effectiveAt:"2026-10-12T12:00:00.000Z"},
    {id:"claim-nova-b", serviceId:"payments-api", sourceId:"change-control-nova-b", rank:80,
      ownerId:"cora", effectiveAt:"2026-10-12T19:00:00.000+07:00"},
    // Lyra: an ownership claim that no source attests -> must refuse.
    {id:"claim-lyra-unsourced", serviceId:"search-index", sourceId:null, rank:null,
      ownerId:"dev", effectiveAt:"2026-10-10T08:00:00.000Z"}
  ]
};
