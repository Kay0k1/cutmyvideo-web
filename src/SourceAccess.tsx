import { createContext, useContext } from 'react';

/** Only the collection workspace supplies a server-verified project ID. */
export const SourceAccess = createContext<string | undefined>(undefined);
export function projectAPIBase(projectID?: string): string {
  if (projectID === undefined) return '/api/v1';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(projectID)) throw new Error('invalid project ID');
  return '/api/v1/projects/' + encodeURIComponent(projectID);
}
export function useSourceBase(sourceID: string): string {
  return projectAPIBase(useContext(SourceAccess)) + '/sources/' + encodeURIComponent(sourceID);
}
