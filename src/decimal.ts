/**
 * Re-export of `@primebrick/decimal` — the arbitrary-precision decimal type
 * flows through core so downstream libraries (dal, sdk, ui) can re-export it
 * to their consumers (FE/BE/US) without each repo wiring its own dependency.
 */
export * from "@primebrick/decimal";
