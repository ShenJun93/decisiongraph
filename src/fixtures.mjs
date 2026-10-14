// Clearly synthetic data. Constructed after Graph Hacks opened on 2026-10-15 01:31 ICT.
export const PROJECT_ID = "orion";
export const SERVICE_ID = "billing-gateway";
export const GRAPH_FIXTURE = {
  projects: [{id: "orion", name: "Project Orion"}],
  services: [{id: "billing-gateway", name: "Billing Gateway"}],
  people: [
    {id:"aria",name:"Aria (synthetic)"},
    {id:"ben",name:"Ben (synthetic)"},
    {id:"cora",name:"Cora (synthetic)"}
  ],
  claims: [
    {id:"claim-legacy", sourceId:"directory-sep",rank:90,
      ownerId:"aria",effectiveAt:"2026-09-20T08:00:00.000Z"},
    {id:"claim-current", sourceId:"change-control-oct",rank:90,
      ownerId:"ben",effectiveAt:"2026-10-14T11:00:00.000Z"},
    {id:"claim-chat", sourceId:"chat-note-oct",rank:35,
      ownerId:"aria",effectiveAt:"2026-10-14T16:00:00.000Z"}
  ]
};
