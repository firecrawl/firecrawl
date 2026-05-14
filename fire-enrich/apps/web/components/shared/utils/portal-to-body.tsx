import dynamic from "next/dynamic";
import { createPortal } from "react-dom";

function PortalToBody({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}

export default dynamic(() => Promise.resolve(PortalToBody), { ssr: false });
