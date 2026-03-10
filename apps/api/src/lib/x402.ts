import { config } from "../config";
import {
  paymentMiddleware,
  x402ResourceServer as X402ResourceServer,
  type Network,
} from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";

// Network name to CAIP-2 chain ID mapping
const NETWORK_TO_CAIP2: Record<string, Network> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
  "avalanche-fuji": "eip155:43113",
  avalanche: "eip155:43114",
  iotex: "eip155:4689",
};

// Get the CAIP-2 network identifier
function getX402Network(): Network {
  const network = config.X402_NETWORK || "base-sepolia";
  return NETWORK_TO_CAIP2[network] || (network as Network);
}

// Create the resource server with EVM support
// Note: Using a lazy initialization pattern to avoid issues at module load time
let _resourceServer: X402ResourceServer | null = null;

export function getX402ResourceServer(): X402ResourceServer {
  if (!_resourceServer) {
    const facilitatorUrl =
      config.X402_FACILITATOR_URL || "https://x402.org/facilitator";
    const facilitatorClient = new HTTPFacilitatorClient({
      url: facilitatorUrl,
    });
    _resourceServer = new X402ResourceServer(facilitatorClient);
    registerExactEvmScheme(_resourceServer, {
      networks: [getX402Network()],
    });
  }
  return _resourceServer;
}

// Check if x402 payments are enabled (requires valid X402_PAY_TO_ADDRESS)
export function isX402Enabled(): boolean {
  return !!config.X402_PAY_TO_ADDRESS;
}

// Get the pay-to address (only call when isX402Enabled() returns true)
function getX402PayToAddress(): `0x${string}` {
  if (!config.X402_PAY_TO_ADDRESS) {
    throw new Error(
      "X402_PAY_TO_ADDRESS is not configured. Check isX402Enabled() before calling this.",
    );
  }
  return config.X402_PAY_TO_ADDRESS;
}

// Helper to create route config for x402 endpoints
export function createX402RouteConfig(
  route: string,
  description: string,
  _inputSchema: Record<string, unknown>,
  _outputSchema: Record<string, unknown>,
): Record<
  string,
  {
    accepts: {
      scheme: string;
      network: Network;
      price: string;
      payTo: `0x${string}`;
    };
    description: string;
  }
> {
  return {
    [route]: {
      accepts: {
        scheme: "exact",
        network: getX402Network(),
        price: config.X402_ENDPOINT_PRICE_USD || "$0.01",
        payTo: getX402PayToAddress(),
      },
      description,
    },
  };
}

// Export payment middleware
export { paymentMiddleware };
