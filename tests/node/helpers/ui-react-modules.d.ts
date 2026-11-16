/**
 * The UI workspaces pin their own React copy (`extensions/pidash/pidash-ui/node_modules/react`
 * is not the root version), so DOM tests import it by path to keep a single instance.
 *
 * TypeScript resolves that path to the package's plain JS entry and loses the typings, so map
 * the paths back onto the root `@types/react` declarations. Without this the tests project has
 * to `allowJs` its way through React and every hook assertion becomes `any`.
 */
declare module "*/node_modules/react/index.js" {
	import React = require("react");
	export = React;
}

declare module "*/node_modules/react-dom/client.js" {
	import Client = require("react-dom/client");
	export = Client;
}
