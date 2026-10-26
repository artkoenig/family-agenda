/** The id a Source plugin gives its Source Type, such as `ics`; the core never branches on it. */
export type SourceTypeId = string & { readonly __brand: "SourceTypeId" };

export type SourceId = string & { readonly __brand: "SourceId" };
