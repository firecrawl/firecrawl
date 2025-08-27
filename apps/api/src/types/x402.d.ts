declare module 'x402' {
  export * from 'x402/dist/cjs/types/index';
}

declare module 'x402/dist/cjs/types/index' {
  // Type definitions
  export interface ChainConfig {
    [key: string]: any;
  }
  
  export interface ConnectedClient {
    [key: string]: any;
  }
  
  export interface SignerWallet {
    [key: string]: any;
  }
  
  // Value exports (constants)
  export const index_ChainConfig: any;
  export const index_ConnectedClient: any;
  export const index_SignerWallet: any;
  
  // Re-export everything else that might be in the module
  const _default: any;
  export default _default;
}

declare module 'x402-express' {
  export function paymentMiddleware(...args: any[]): any;
  
  // Export any other functions or types that might be used
  export * from 'x402-express';
} 