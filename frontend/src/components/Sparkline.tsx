import { memo, useId } from 'react';

export const Sparkline = memo(function Sparkline({ data, color, className = "" }: { data: number[], color?: string, className?: string }) {
  // Create a unique ID for the gradient based on the color to avoid collisions if multiple instances render
  const id = useId();
  const gradId = `sparkline-gradient-${id.replace(/:/g, '')}`;

  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1; // avoid div by zero

  const width = 100;
  const height = 30;

  // Normalize data points to fit within width x height
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((d - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  const isBullish = data[0] <= data[data.length - 1];
  const strokeColor = color || (isBullish ? "#22c55e" : "#ef4444");
  
  const polyPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg 
      viewBox={`0 0 ${width} ${height}`} 
      className={`overflow-visible ${className}`} 
      preserveAspectRatio="none"
      width="100%"
      height="100%"
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.4" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <polygon 
        points={polyPoints} 
        fill={`url(#${gradId})`} 
      />
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
});
