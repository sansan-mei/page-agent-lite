// Developer build only: `npm run build:dev` copies this file into dist/extension-dev/ and
// background-dev.js loads it first. The runtime then runs run_script WITHOUT the per-run
// side-panel approval that the store build requires. Never ship this file in extension/.
globalThis.PageAgentDevFlags=Object.freeze({autoApproveScripts:true});
