
import React from 'react';
import AuraCard from './AuraCard';
import { Cpu, Server, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';

const SystemStatus = () => {
    const [stats, setStats] = React.useState({
        recordCount: 0,
        startTime: null,
        lastGovernanceMode: 'UNKNOWN'
    });
    // Removed redundant require

    React.useEffect(() => {
        const fetchSystemStats = async () => {
            // 1. Total Rows
            const { count } = await supabase.from('audit_ledger').select('*', { count: 'exact', head: true });

            // 2. First Record (Uptime logic: time since first record)
            const { data: firstRecord } = await supabase
                .from('audit_ledger')
                .select('created_at')
                .order('created_at', { ascending: true })
                .limit(1)
                .single();

            // 3. Last Record (Governance Mode)
            const { data: lastRecord } = await supabase
                .from('audit_ledger')
                .select('ops_stream')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            setStats({
                recordCount: count || 0,
                startTime: firstRecord?.created_at,
                lastGovernanceMode: lastRecord?.ops_stream?.invariant_check === 'passed' ? 'ENFORCED' : 'MONITORING'
            });
        };

        fetchSystemStats();
        // Optional: subscribe to changes can be added here, but simple poll or on-mount is strictly what's needed for the task
        const interval = setInterval(fetchSystemStats, 30000); // Poll every 30s
        return () => clearInterval(interval);
    }, []);

    // Calculate Uptime
    const getUptime = () => {
        if (!stats.startTime) return "CALCULATING...";
        const start = new Date(stats.startTime);
        const now = new Date();
        const diff = now - start;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
        return `${days}d ${hours}h`;
    };

    return (
        <div className="p-6 lg:p-8 max-w-[1600px] mx-auto space-y-6">
            <h2 className="text-xl font-bold text-white font-mono tracking-tight mb-4">SYSTEM_STATUS</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <AuraCard className="bg-black/60 flex items-center space-x-4">
                    <div className="p-3 bg-primary/10 rounded-full">
                        <Server className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                        <div className="text-xs text-gray-500 font-mono uppercase">Storage Records</div>
                        <div className="text-2xl font-bold text-white">{stats.recordCount.toLocaleString()}</div>
                    </div>
                </AuraCard>
                <AuraCard className="bg-black/60 flex items-center space-x-4">
                    <div className="p-3 bg-primary/10 rounded-full">
                        <Cpu className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                        <div className="text-xs text-gray-500 font-mono uppercase">System Uptime</div>
                        <div className="text-2xl font-bold text-white">{getUptime()}</div>
                    </div>
                </AuraCard>
                <AuraCard className="bg-black/60 flex items-center space-x-4">
                    <div className="p-3 bg-primary/10 rounded-full">
                        <ShieldCheck className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                        <div className="text-xs text-gray-500 font-mono uppercase">Governance Mode</div>
                        <div className="text-2xl font-bold text-white text-primary drop-shadow-[0_0_5px_rgba(0,255,157,0.5)]">
                            {stats.lastGovernanceMode}
                        </div>
                    </div>
                </AuraCard>
            </div>

            <AuraCard className="bg-black/40 h-96 flex items-center justify-center">
                <div className="text-center">
                    <div className="w-16 h-16 border-4 border-primary/20 border-t-primary rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-primary font-mono text-sm tracking-widest animate-pulse">SYSTEM_DIAGNOSTICS_RUNNING...</p>
                </div>
            </AuraCard>
        </div>
    );
};

export default SystemStatus;
