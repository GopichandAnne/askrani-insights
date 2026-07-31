/** Client-safe types/constants shared between the Ask Rani server + UI. */

/** A citable source shown under a streamed answer (clickable when we have a URL). */
export interface Source {
  id: number;
  business: string;
  platform: string;
  label: string;
  url?: string;
}

/** The streamed answer appends the sources JSON after this sentinel so the
 *  client can split answer-text from citation metadata in one response. */
export const SOURCES_SENTINEL = "\n<<SRC>>";
