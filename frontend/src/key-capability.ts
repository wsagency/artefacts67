export const shouldShowContentReadCheck = (kind: string, hasMaster: boolean): boolean =>
  kind === 'master' && !hasMaster;
