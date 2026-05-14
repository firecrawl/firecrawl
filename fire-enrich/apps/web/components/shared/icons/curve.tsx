interface CurveProps extends React.SVGAttributes<SVGSVGElement> {
  fill?: string;
}

export default function Curve({
  fill = "var(--border-faint)",
  ...props
}: CurveProps) {
  return (
    <svg
      fill="none"
      height="11"
      viewBox="0 0 11 11"
      width="11"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M11 1L11 11L10 11L10 7C10 3.68629 7.31371 1 4 1L-4.37114e-08 1L0 -4.80825e-07L11 4.37114e-07L11 1Z"
        fill={fill}
      />
    </svg>
  );
}
