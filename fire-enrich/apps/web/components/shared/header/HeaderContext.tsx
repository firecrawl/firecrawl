"use client";

import { usePathname } from "next/navigation";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

interface HeaderContextType {
  dropdownContent: React.ReactNode;
  setDropdownContent: (content: React.ReactNode) => void;
  clearDropdown: (force?: boolean) => void;
  resetDropdownTimeout: () => void;
  dropdownKey: number;
  headerHeight: React.RefObject<number>;
  headerTop: React.RefObject<number>;
}

const HeaderContext = createContext<HeaderContextType | undefined>(undefined);

export const HeaderProvider = ({ children }: { children: React.ReactNode }) => {
  const [dropdownContent, setDropdownContent] = useState<React.ReactNode>(null);
  const [dropdownKey, setDropdownKey] = useState(0);
  const headerHeight = useRef(0);
  const headerTop = useRef(0);
  const pathname = usePathname();
  const timeout = useRef<number | null>(null);

  const clearDropdown = (force?: boolean) => {
    if (force) {
      setDropdownContent(null);

      return;
    }

    if (timeout.current) {
      clearTimeout(timeout.current);
    }

    timeout.current = window.setTimeout(() => {
      setDropdownContent(null);
    }, 500);
  };

  const resetDropdownTimeout = () => {
    if (timeout.current) {
      clearTimeout(timeout.current);
    }
  };

  useEffect(() => {
    const header = document.querySelector(".header") as HTMLElement;

    if (header) {
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          headerHeight.current = entry.contentRect.height;
        }
      });

      resizeObserver.observe(header);
      headerHeight.current = header.clientHeight;
      headerTop.current = header.getBoundingClientRect().top;

      const onScroll = () => {
        headerTop.current = header.getBoundingClientRect().top;
      };

      window.addEventListener("scroll", onScroll, { passive: true });

      return () => {
        resizeObserver.disconnect();
        window.removeEventListener("scroll", onScroll);
      };
    }
  }, [pathname]);

  return (
    <HeaderContext.Provider
      value={{
        dropdownContent,
        setDropdownContent: (content) => {
          resetDropdownTimeout();

          if (content === dropdownContent) return;
          setDropdownKey((prev) => prev + 1);
          setDropdownContent(content);
        },
        clearDropdown,
        resetDropdownTimeout,
        dropdownKey,
        headerHeight,
        headerTop,
      }}
    >
      {children}
    </HeaderContext.Provider>
  );
};

export const useHeaderContext = () => {
  const context = useContext(HeaderContext);

  if (!context) {
    throw new Error("useHeaderContext must be used within a HeaderProvider");
  }

  return context;
};

export const useHeaderHeight = () => {
  const [headerHeight, setHeaderHeight] = useState(0);

  useEffect(() => {
    const header = document.querySelector(".header");

    if (header) {
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setHeaderHeight(entry.contentRect.height);
        }
      });

      resizeObserver.observe(header);
      setHeaderHeight(header.clientHeight);

      return () => {
        resizeObserver.disconnect();
      };
    }
  }, []);

  return { headerHeight };
};
