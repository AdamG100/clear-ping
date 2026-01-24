# ClearPing

A modern network monitoring tool inspired by Smokeping, built with Next.js, React, and TypeScript.

## Features

### 🎯 Network Monitoring
- **ICMP Ping Probing** - Monitor host latency and packet loss
- **DNS Query Probing** - Monitor DNS resolution performance
- **Automatic Scheduling** - Targets are probed automatically at configured intervals (default: 5 minutes)
- **Real-time Updates** - Live graphs and statistics

### 📊 Visualization
- **Smokeping-style Graphs** - Beautiful gradient visualizations showing min/avg/max latency
- **Latency Charts** - Track response times over multiple time ranges (5h, 24h, 7d, 30d, 360d)
- **Packet Loss Charts** - Color-coded visualization from green (0%) to red (>50%)
- **Statistics Cards** - Average latency, jitter, uptime, and packet loss metrics

### 🎨 Packet Loss Color Scheme
- **0%** → Bright Green - Perfect
- **≤5%** → Light Green - Excellent
- **≤10%** → Cyan - Good
- **≤15%** → Light Blue - Acceptable
- **≤20%** → Blue - Degraded
- **≤30%** → Magenta - Concerning
- **≤50%** → Orange - Poor
- **>50%** → Red - Critical

### ⚡ Performance
- **SQLite Database** - Fast, local storage with no external dependencies
- **Background Scheduler** - Automatic probing without blocking the UI
- **Efficient Data Storage** - Indexed queries for fast retrieval

## Getting Started

### Prerequisites
- Node.js 18+ (using npm for package management)
- Windows, macOS, or Linux

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/clearping.git
cd clearping
```

2. Install dependencies:
```bash
npm install
```

3. Copy the SQL.js WASM file:
```bash
# The sql-wasm.wasm file should be in public/
# It's automatically loaded from node_modules/sql.js/dist/
```

4. Run the development server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser

The probe scheduler will start automatically when the first API request is made.

## Usage

### Adding Targets

1. Click the "+" button in the sidebar
2. Enter target details:
   - **Name**: Friendly name for the target
   - **Host**: IP address or domain name
   - **Probe Type**: ICMP Ping or DNS Query
   - **Interval**: Probe frequency in seconds (default: 300 = 5 minutes)
3. Click "Add Target"

### Automatic Probing

- Targets are automatically probed at their configured intervals
- Each probe sends 20 ICMP packets (configurable)
- Results are stored in SQLite database
- Graphs update automatically with new data

See [docs/automatic-probing.md](docs/automatic-probing.md) for detailed documentation.

### Viewing Statistics

Select a target from the sidebar to view:
- **Real-time graphs** showing latency over time
- **Packet loss visualization** with color-coded bars
- **Statistics cards** with avg latency, jitter, uptime, and packet loss
- **Time range selector** (5h, 24h, 7d, 30d, 360d)

## Project Structure

```
clearping/
├── src/
│   ├── app/                    # Next.js app router
│   │   ├── _components/        # React components
│   │   │   ├── monitoring/     # Dashboard components
│   │   │   └── ...
│   │   └── api/                # API routes
│   │       ├── scheduler/      # Scheduler endpoints
│   │       └── targets/        # Target CRUD + probing
│   ├── components/             # shadcn/ui components
│   │   └── ui/
│   ├── lib/                    # Core logic
│   │   ├── scheduler.ts        # Automatic probe scheduler
│   │   ├── ping.ts            # ICMP ping implementation
│   │   ├── dns.ts             # DNS probe implementation
│   │   ├── database.ts        # SQLite operations
│   │   └── packet-loss-colors.ts  # Color scheme utility
│   └── types/                  # TypeScript type definitions
├── docs/                       # Documentation
│   └── automatic-probing.md
├── data/                       # SQLite database (created at runtime)
└── public/                     # Static assets

```

## API Endpoints

### Targets
- `GET /api/targets` - List all targets
- `POST /api/targets` - Create a new target
- `GET /api/targets/:id` - Get target details
- `DELETE /api/targets/:id` - Delete a target
- `POST /api/targets/:id/probe` - Manually probe a target
- `GET /api/targets/:id/measurements?hours=24` - Get measurements

### Scheduler
- `GET /api/scheduler/status` - Get scheduler status
- `POST /api/scheduler/start` - Start the scheduler

## Configuration

### Probe Intervals

Default intervals (in seconds):
- Frequent: `60` (1 minute)
- Default: `300` (5 minutes, like Smokeping)
- Moderate: `600` (10 minutes)
- Hourly: `3600` (1 hour)

### Ping Settings

Edit [src/lib/ping.ts](src/lib/ping.ts) to configure:
```typescript
const { count = 20, timeout = 1000 } = options;
```

- `count`: Number of pings per probe (default: 20)
- `timeout`: Timeout per ping in milliseconds (default: 1000)

## Documentation

- [Automatic Probing Guide](docs/automatic-probing.md) - Detailed documentation about the scheduler

## Technologies

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **UI**: React 19 + Tailwind CSS v4
- **Components**: shadcn/ui + Radix UI
- **Charts**: Recharts
- **Database**: SQLite (sql.js)
- **Icons**: Lucide React

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
