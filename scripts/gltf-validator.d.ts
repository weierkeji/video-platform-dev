declare module 'gltf-validator' {
  export function version(): string;
  export function validateBytes(
    bytes: Uint8Array,
    options?: { uri?: string; maxIssues?: number },
  ): Promise<{
    validatorVersion: string;
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      numHints: number;
      messages: { code: string; message: string; severity: number; pointer?: string }[];
    };
    [key: string]: unknown;
  }>;
}
