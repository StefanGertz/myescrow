#!/usr/bin/env node

const apiBase = (process.env.SMOKE_API_BASE ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const expectedSha = process.env.SMOKE_EXPECTED_SHA;

const versionResponse = await fetch(`${apiBase}/version`);
if (!versionResponse.ok) {
  throw new Error(`Version endpoint returned ${versionResponse.status}.`);
}

const version = await versionResponse.json();
if (version.status !== "ok" || !version.buildSha) {
  throw new Error("Version endpoint did not return a healthy build identifier.");
}
if (expectedSha && version.buildSha !== expectedSha) {
  throw new Error(`Expected build ${expectedSha}, received ${version.buildSha}.`);
}
if (!version.capabilities?.includes("milestone_funding")) {
  throw new Error("Deployed API does not advertise milestone funding.");
}
if (!version.capabilities?.includes("staged_funding_amounts")) {
  throw new Error("Deployed API does not advertise flexible staged funding amounts.");
}
if (!version.capabilities?.includes("agreement_funding_plan")) {
  throw new Error("Deployed API does not advertise agreement funding-plan selection.");
}
if (!version.capabilities?.includes("escrow_chat")) {
  throw new Error("Deployed API does not advertise escrow chat.");
}
if (!version.capabilities?.includes("arbitration_reports")) {
  throw new Error("Deployed API does not advertise arbitration reports.");
}

const routeProbe = await fetch(
  `${apiBase}/api/dashboard/escrows/DEPLOYMENT-PROBE/milestones/1/fund`,
  {
    method: "POST",
    headers: { "Idempotency-Key": "deployment-route-probe" },
  },
);
if (routeProbe.status !== 401) {
  const body = await routeProbe.text();
  throw new Error(
    `Milestone funding route probe returned ${routeProbe.status}; expected 401. ${body}`,
  );
}

const chatRouteProbe = await fetch(
  `${apiBase}/api/dashboard/escrows/DEPLOYMENT-PROBE/messages`,
);
if (chatRouteProbe.status !== 401) {
  const body = await chatRouteProbe.text();
  throw new Error(
    `Escrow chat route probe returned ${chatRouteProbe.status}; expected 401. ${body}`,
  );
}

const arbitrationReportRouteProbe = await fetch(
  `${apiBase}/api/dashboard/disputes/DEPLOYMENT-PROBE/arbitration-report`,
);
if (arbitrationReportRouteProbe.status !== 401) {
  const body = await arbitrationReportRouteProbe.text();
  throw new Error(
    `Arbitration report route probe returned ${arbitrationReportRouteProbe.status}; expected 401. ${body}`,
  );
}

console.log(`Deployment smoke test passed for ${version.buildSha}.`);
