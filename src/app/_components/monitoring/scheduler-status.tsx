'use client';

import { useState, useEffect } from 'react';
import { Activity, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface SchedulerTarget {
  id: string;
  name: string;
  host: string;
  interval: number;
  lastProbeTime: number;
  nextProbeIn: number;
  isProbing: boolean;
}

interface SchedulerStatus {
  isRunning: boolean;
  targetCount: number;
  targets: SchedulerTarget[];
}

export function SchedulerStatus() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/scheduler/status');
        if (response.ok) {
          const data = await response.json();
          setStatus(data);
        }
      } catch (error) {
        console.error('Failed to fetch scheduler status:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    
    // Refresh status every 5 seconds
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading || !status) {
    return null;
  }

  const formatTime = (ms: number): string => {
    if (ms < 1000) return 'now';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  const formatLastProbe = (timestamp: number): string => {
    if (timestamp === 0) return 'Never';
    const ago = Date.now() - timestamp;
    return `${formatTime(ago)} ago`;
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className={`h-4 w-4 ${status.isRunning ? 'text-success animate-pulse' : 'text-muted-foreground'}`} />
            <CardTitle className="text-base">Probe Scheduler</CardTitle>
          </div>
          {status.isRunning ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-success/20 text-success">
              <CheckCircle2 className="h-3 w-3" />
              Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-destructive/20 text-destructive">
              <AlertCircle className="h-3 w-3" />
              Stopped
            </span>
          )}
        </div>
        <CardDescription>
          {status.targetCount} {status.targetCount === 1 ? 'target' : 'targets'} scheduled for automatic probing
        </CardDescription>
      </CardHeader>
      {status.targets.length > 0 && (
        <CardContent className="pb-4">
          <div className="space-y-2">
            {status.targets.map((target) => (
              <div
                key={target.id}
                className="flex items-center justify-between p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">
                      {target.name}
                    </p>
                    {target.isProbing && (
                      <Activity className="h-3 w-3 text-primary animate-spin shrink-0" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{target.host}</p>
                </div>
                <div className="flex flex-col items-end gap-0.5 ml-4 shrink-0">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span>{formatTime(target.nextProbeIn)}</span>
                  </div>
                  <span className="text-xs text-muted-foreground/60">
                    Last: {formatLastProbe(target.lastProbeTime)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
