/**
 * The part of jsdom the browser tests use. `@types/jsdom` would add the types of the browser to the
 * whole project, where server code must not see them.
 */
declare module "jsdom" {
  export interface BrowserElement {
    textContent: string;
    click(): void;
    querySelector(selector: string): BrowserElement | null;
    querySelectorAll(selector: string): { length: number };
  }
  type Evaluate = (this: unknown, node: unknown, type?: number, result?: unknown) => unknown;
  export interface DOMWindow {
    document: BrowserElement;
    XPathExpression: { prototype: { evaluate: Evaluate } };
    close(): void;
  }
  export class VirtualConsole {
    on(event: "jsdomError", listener: (error: Error) => void): this;
  }
  export class JSDOM {
    static fromURL(
      url: string,
      options: { runScripts: "dangerously"; resources: "usable"; virtualConsole: VirtualConsole; beforeParse: (window: DOMWindow) => void },
    ): Promise<JSDOM>;
    readonly window: DOMWindow;
  }
}
