export default function CenterStar({
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      fill="none"
      height="47"
      viewBox="0 0 47 47"
      width="47"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M24 18C24 21.3137 26.6863 24 30 24H34V25H30C26.6863 25 24 27.6863 24 31V35H23V31C23 27.6863 20.3137 25 17 25H13V24H17C20.3137 24 23 21.3137 23 18V14H24V18Z"
        fill="var(--heat-100)"
        fillOpacity="1"
      />
      <circle cx="23.5" cy="23.5" r="23" stroke="#EDEDED" strokeOpacity="1" />
    </svg>
  );
}
