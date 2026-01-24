'use client';

import React from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';
import { SmokeGraphData } from '@/types/probe';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { Button } from '@/components/ui/button';
import { Activity, RefreshCw } from 'lucide-react';

interface SmokeGraphProps {
  data: SmokeGraphData[];
  height?: number;
  targetName: string;
  targetHost: string;
  onProbe: () => void;
  probing: boolean;
}

const chartConfig = {
  latency: {
    label: 'Latency',
    color: 'hsl(200 95% 65%)', // Bright blue
  },
  max: {
    label: 'Maximum',
    color: 'hsl(0 85% 70%)', // Bright red for spikes
  },
  avg: {
    label: 'Average',
    color: 'hsl(200 95% 65%)', // Bright blue for average
  },
  min: {
    label: 'Minimum',
    color: 'hsl(142 85% 65%)', // Bright green for minimum
  },
} satisfies ChartConfig;

/**
 * SmokeGraph Component
 * Creates a beautiful smoke-style visualization with gradients and area fills
 */
export function SmokeGraph({ 
  data, 
  height = 400, 
  targetName, 
  targetHost, 
  onProbe, 
  probing 
}: SmokeGraphProps) {
  // Transform data for the chart
  const chartData = data
    .filter(d => d.latency !== null)
    .map(d => ({
      time: format(d.timestamp, 'HH:mm:ss'),
      timestamp: d.timestamp.getTime(),
      latency: d.latency || 0,
      max: d.max || d.latency || 0,
      avg: d.avg || d.latency || 0,
      min: d.min || d.latency || 0,
    }));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>{targetName}</CardTitle>
            <CardDescription>{targetHost}</CardDescription>
          </div>
          <Button
            onClick={onProbe}
            disabled={probing}
          >
            {probing ? (
              <>
                <Activity className="w-4 h-4 mr-2 animate-spin" />
                Probing...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Probe Now
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="w-full" style={{ height }}>
          <AreaChart
            data={chartData}
            margin={{
              top: 10,
              right: 10,
              left: 0,
              bottom: 0,
            }}
          >
            <defs>
              {/* Gradient for max area - bright red for spikes with smoke fade */}
              <linearGradient id="fillMax" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="hsl(0 85% 70%)"
                  stopOpacity={0.9}
                />
                <stop
                  offset="50%"
                  stopColor="hsl(0 85% 70%)"
                  stopOpacity={0.4}
                />
                <stop
                  offset="100%"
                  stopColor="hsl(0 85% 70%)"
                  stopOpacity={0.05}
                />
              </linearGradient>
              {/* Gradient for average area - bright blue with smoke fade */}
              <linearGradient id="fillAvg" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="hsl(200 95% 65%)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="50%"
                  stopColor="hsl(200 95% 65%)"
                  stopOpacity={0.35}
                />
                <stop
                  offset="100%"
                  stopColor="hsl(200 95% 65%)"
                  stopOpacity={0.05}
                />
              </linearGradient>
              {/* Gradient for min area - bright green with smoke fade */}
              <linearGradient id="fillMin" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="hsl(142 85% 65%)"
                  stopOpacity={0.7}
                />
                <stop
                  offset="50%"
                  stopColor="hsl(142 85% 65%)"
                  stopOpacity={0.3}
                />
                <stop
                  offset="100%"
                  stopColor="hsl(142 85% 65%)"
                  stopOpacity={0.05}
                />
              </linearGradient>
            </defs>
            <CartesianGrid 
              strokeDasharray="3 3" 
              vertical={false}
              stroke="hsl(var(--border))"
              opacity={0.3}
            />
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                return value;
              }}
              style={{
                fontSize: '12px',
                fill: 'hsl(var(--muted-foreground))',
              }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}ms`}
              style={{
                fontSize: '12px',
                fill: 'hsl(var(--muted-foreground))',
              }}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value, payload) => {
                    if (payload && payload[0]) {
                      const timestamp = payload[0].payload.timestamp;
                      return format(new Date(timestamp), 'MMM d, HH:mm:ss');
                    }
                    return value;
                  }}
                  indicator="line"
                />
              }
            />
            {/* Max latency area - shows the worst case spikes with smoke effect */}
            <Area
              dataKey="max"
              type="monotone"
              fill="url(#fillMax)"
              stroke="hsl(0 85% 70%)"
              strokeWidth={2.5}
              fillOpacity={1}
              stackId="a"
            />
            {/* Average latency area - the main signal with bright smoke */}
            <Area
              dataKey="avg"
              type="monotone"
              fill="url(#fillAvg)"
              stroke="hsl(200 95% 65%)"
              strokeWidth={3}
              fillOpacity={1}
            />
            {/* Min latency area - baseline with subtle smoke */}
            <Area
              dataKey="min"
              type="monotone"
              fill="url(#fillMin)"
              stroke="hsl(142 85% 65%)"
              strokeWidth={2}
              fillOpacity={1}
            />
          </AreaChart>
        </ChartContainer>
        
        {/* Legend */}
        <div className="flex items-center justify-center gap-6 mt-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(142 85% 65%)' }} />
            <span className="text-muted-foreground">Min</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(200 95% 65%)' }} />
            <span className="text-muted-foreground">Avg</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(0 85% 70%)' }} />
            <span className="text-muted-foreground">Max</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
