import { cn } from "@/utils/cn";

import Curve from "@/components/shared/icons/curve";

interface CurvyRectProps extends React.HTMLAttributes<HTMLDivElement> {
  allSides?: boolean;

  x?: boolean;
  y?: boolean;

  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;

  topLeft?: boolean;
  topRight?: boolean;
  bottomLeft?: boolean;
  bottomRight?: boolean;
}

export default function CurvyRect({
  className,
  allSides,
  x,
  y,
  left,
  right,
  top,
  bottom,
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
  ...props
}: CurvyRectProps) {
  const hasTopLeft = topLeft || top || left || x || allSides;
  const hasTopRight = topRight || top || right || x || allSides;
  const hasBottomLeft = bottomLeft || bottom || left || y || allSides;
  const hasBottomRight = bottomRight || bottom || right || y || allSides;

  return (
    <div
      className={cn(
        className,
        "pointer-events-none contain-[layout,paint] curvy-rect",
      )}
      {...props}
    >
      {hasTopLeft && <Curve className="-rotate-90 absolute top-0 left-0" />}
      {hasTopRight && <Curve className="absolute top-0 right-0" />}
      {hasBottomLeft && (
        <Curve className="rotate-180 absolute bottom-0 left-0" />
      )}
      {hasBottomRight && (
        <Curve className="rotate-90 absolute bottom-0 right-0" />
      )}
    </div>
  );
}

export const Connector = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      fill="none"
      height="21"
      viewBox="0 0 22 21"
      width="22"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      className={cn(
        "pointer-events-none contain-[layout,paint] absolute",
        className,
      )}
    >
      <path
        d="M10.5 4C10.5 7.31371 7.81371 10 4.5 10H0.5V11H4.5C7.81371 11 10.5 13.6863 10.5 17V21H11.5V17C11.5 13.6863 14.1863 11 17.5 11H21.5V10H17.5C14.1863 10 11.5 7.31371 11.5 4V0H10.5V4Z"
        fill="#EDEDED"
      />
    </svg>
  );
};

export const ConnectorToRight = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      fill="none"
      height="21"
      viewBox="0 0 11 21"
      width="11"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      className={cn(
        "pointer-events-none contain-[layout,paint] absolute",
        className,
      )}
    >
      <path
        d="M1 4C1 7.31371 3.68629 10 7 10H11V11H7C3.68629 11 1 13.6863 1 17V21H0V0H1V4Z"
        fill="#EDEDED"
      />
    </svg>
  );
};

export const ConnectorToLeft = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      fill="none"
      height="21"
      viewBox="0 0 11 21"
      width="11"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      className={cn(
        "pointer-events-none contain-[layout,paint] absolute",
        className,
      )}
    >
      <path
        d="M11 21H10V17C10 13.6863 7.31371 11 4 11H0V10H4C7.31371 10 10 7.31371 10 4V0H11V21Z"
        fill="#EDEDED"
      />
    </svg>
  );
};

export const ConnectorToTop = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      fill="none"
      height="11"
      viewBox="0 0 21 11"
      width="21"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      className={cn(
        "pointer-events-none contain-[layout,paint] absolute",
        className,
      )}
    >
      <path
        d="M11 4C11 7.31371 13.6863 10 17 10H21V11H0V10H4C7.31371 10 10 7.31371 10 4V0H11V4Z"
        fill="#EDEDED"
      />
    </svg>
  );
};

export const ConnectorToBottom = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      fill="none"
      height="11"
      viewBox="0 0 21 11"
      width="21"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      className={cn(
        "pointer-events-none contain-[layout,paint] absolute",
        className,
      )}
    >
      <path
        d="M11 7C11 3.68629 13.6863 1 17 1H21V0H0V1H4C7.31371 1 10 3.68629 10 7V11H11V7Z"
        fill="#EDEDED"
      />
    </svg>
  );
};
