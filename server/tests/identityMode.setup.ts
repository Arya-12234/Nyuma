import { IDENTITY_MODE_LOCAL_HS256_TEST } from "../src/config/env.js";
import { configureIdentityMode } from "../src/db/session.js";

// The suite's database tests use the local HS256 verifier. This is not an API default
// and it is not production-safe. Signer tests select signer mode themselves.
configureIdentityMode(IDENTITY_MODE_LOCAL_HS256_TEST);
