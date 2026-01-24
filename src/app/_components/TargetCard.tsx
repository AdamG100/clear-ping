'use client';

import React from 'react';
import { Target, TargetStatistics } from '@/types/probe';
import { getPacketLossColorInfo } from '@/lib/packet-loss-colors';

interface TargetCardProps {
  target: Target;
  statistics?: TargetStatistics | null;
  onProbe?: (targetId: string) => void;
  onDelete?: (targetId: string) => void;
}

export function TargetCard({ 
  target, 
  statistics, 
  onProbe,
  onDelete 
}: TargetCardProps) {
  const getStatusColor = () => {
    if (target.status === 'active') {
      return statistics && statistics.uptime >= 95
        ? 'bg-green-100 text-green-800'
        : 'bg-yellow-100 text-yellow-800';
    }
    if (target.status === 'paused') return 'bg-gray-100 text-gray-800';
    return 'bg-red-100 text-red-800';
  };

  const getProbeTypeLabel = () => {
    return target.probeType === 'ping' ? 'ICMP Ping' : 'DNS Query';
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-gray-900">{target.name}</h3>
          <p className="text-sm text-gray-500">{target.host}</p>
        </div>
        <span className={`px-2 py-1 text-xs font-medium rounded ${getStatusColor()}`}>
          {target.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <p className="text-xs text-gray-500">Probe Type</p>
          <p className="text-sm font-medium text-gray-900">{getProbeTypeLabel()}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Interval</p>
          <p className="text-sm font-medium text-gray-900">{target.interval}s</p>
        </div>
      </div>

      {statistics && (
        <div className="border-t border-gray-100 pt-3 mb-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500">Avg Latency</p>
              <p className="text-sm font-medium text-gray-900">
                {statistics.avgLatency.toFixed(1)}ms
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Uptime</p>
              <p className="text-sm font-medium text-gray-900">
                {statistics.uptime.toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Min/Max</p>
              <p className="text-sm font-medium text-gray-900">
                {statistics.minLatency.toFixed(0)}/{statistics.maxLatency.toFixed(0)}ms
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Packet Loss</p>
              <p className="text-sm font-medium" style={{ color: getPacketLossColorInfo(statistics.packetLoss).hex }}>
                {statistics.packetLoss.toFixed(1)}%
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {onProbe && (
          <button
            onClick={() => onProbe(target.id)}
            className="flex-1 px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 rounded hover:bg-blue-100 transition-colors cursor-pointer"
          >
            Probe Now
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => onDelete(target.id)}
            className="px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 rounded hover:bg-red-100 transition-colors cursor-pointer"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
