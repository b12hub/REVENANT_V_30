import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export const useExecutiveMetrics = () => {
    const [metrics, setMetrics] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetchMetrics = async () => {
        try {
            const { data, error } = await supabase.rpc('get_ceo_metrics');
            if (error) throw error;

            // Handle array response (supabase rpc often returns arrays)
            const rawMetrics = Array.isArray(data) ? data[0] : data;

            // Ensure total_savings is accessible and clean
            // If the RPC didn't map it, we map it here from the jsonb column
            const processedMetrics = {
                ...rawMetrics,
                total_savings: rawMetrics?.total_savings
                    ?? rawMetrics?.economics?.net_savings
                    ?? 0,
                rejected_tickets: rawMetrics?.rejected_tickets ?? 0,
                processed_tickets: rawMetrics?.processed_tickets ?? 0
            };

            setMetrics(processedMetrics);
        } catch (err) {
            console.error('Error fetching CEO metrics:', err);
            setError(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // Initial fetch
        fetchMetrics();

        // Real-time subscription
        const channel = supabase
            .channel('audit-ledger-db-changes')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'audit_ledger',
                },
                (payload) => {
                    console.log('New audit log detected, refreshing metrics...', payload);
                    fetchMetrics();
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, []);

    return { metrics, loading, error };
};
