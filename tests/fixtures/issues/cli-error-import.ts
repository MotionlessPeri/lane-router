import { LocalRouterClient } from "../../../src/process/local-client.js";

// Executable-output fixture: refusal occurs before discovery, without contacting any Router.
LocalRouterClient.prototype.call = async () => { throw Object.assign(new Error("Business key conflicts"), { code: "OPERATION_CONFLICT" }); };
