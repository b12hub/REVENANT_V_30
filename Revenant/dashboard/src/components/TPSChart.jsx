import React, { useEffect, useRef } from 'react';

export const TPSChart = () => {
    // Static element references (bypassing the Virtual DOM)
    const canvasRef = useRef(null);
    const tpsValueRef = useRef(null);
    const peakValueRef = useRef(null);

    // Mutable state references (zero-GC, no re-renders)
    const wsRef = useRef(null);
    const animationRef = useRef(0);
    const currentTpsRef = useRef(0);
    const maxTpsRef = useRef(1000);
    const prevYRef = useRef(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        const tpsLabel = tpsValueRef.current;
        const peakLabel = peakValueRef.current;
        if (!canvas || !tpsLabel || !peakLabel) return;

        // 1. Canvas Setup (Hardware Accelerated)
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        canvas.width = width;
        canvas.height = height;

        // Institutional Mode Base Theme
        ctx.fillStyle = '#0B0C10'; // Deep slate void
        ctx.fillRect(0, 0, width, height);
        prevYRef.current = height;

        // 2. The Firehose Connection
        const ws = new WebSocket('ws://127.0.0.1:8080/api/v1/firehose');
        wsRef.current = ws;

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.tps !== undefined) {
                    currentTpsRef.current = data.tps;
                }
            } catch (e) {
                // Silently drop malformed firehose packets
            }
        };

        // 3. The Zero-GC Rendering Loop
        const render = () => {
            const tps = currentTpsRef.current;

            // Dynamic Auto-Scaling
            if (tps > maxTpsRef.current * 0.9) {
                maxTpsRef.current = tps * 1.2;
            } else {
                maxTpsRef.current = Math.max(1000, maxTpsRef.current * 0.999);
            }

            const y = height - (tps / maxTpsRef.current) * height;

            // Shift the entire memory buffer left by 1 pixel
            ctx.drawImage(canvas, -1, 0);

            // Clear the newly exposed rightmost 1-pixel column
            ctx.fillStyle = '#0B0C10';
            ctx.fillRect(width - 1, 0, 1, height);

            // Draw faint structural grid lines
            ctx.fillStyle = '#1F232B';
            ctx.fillRect(width - 1, height / 2, 1, 1);
            ctx.fillRect(width - 1, height * 0.25, 1, 1);

            // Draw the telemetry line segment
            ctx.beginPath();
            ctx.strokeStyle = '#00FA9A'; // Institutional neon green
            ctx.lineWidth = 1.5;
            ctx.imageSmoothingEnabled = false;

            ctx.moveTo(width - 2, prevYRef.current);
            ctx.lineTo(width - 1, y);
            ctx.stroke();

            // RAW DOM MUTATION (Bypasses React completely)
            tpsLabel.innerText = tps.toLocaleString();
            peakLabel.innerText = Math.floor(maxTpsRef.current).toLocaleString();

            prevYRef.current = y;
            animationRef.current = requestAnimationFrame(render);
        };

        animationRef.current = requestAnimationFrame(render);

        // 4. Teardown
        return () => {
            cancelAnimationFrame(animationRef.current);
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, []);

    return (
        <div
            style={{
                position: 'relative',
                width: '100%',
                height: '250px',
                backgroundColor: '#0B0C10',
                border: '1px solid #1F232B',
                borderRadius: '4px',
                overflow: 'hidden',
                fontFamily: '"JetBrains Mono", "Courier New", monospace',
            }}
        >
            <div style={{ position: 'absolute', top: 12, left: 16, zIndex: 10 }}>
                <div style={{ color: '#8892B0', fontSize: '11px', fontWeight: 600, letterSpacing: '1px' }}>
                    NETWORK THROUGHPUT
                </div>
                <div style={{ color: '#FFFFFF', fontSize: '24px', fontWeight: 700, marginTop: '2px' }}>
                    <span ref={tpsValueRef}>0</span> <span style={{ fontSize: '14px', color: '#00FA9A' }}>TPS</span>
                </div>
            </div>

            <div style={{ position: 'absolute', top: 12, right: 16, zIndex: 10, textAlign: 'right' }}>
                <div style={{ color: '#8892B0', fontSize: '11px', fontWeight: 600 }}>PEAK SCALE</div>
                <div style={{ color: '#454A59', fontSize: '14px', fontWeight: 600, marginTop: '4px' }}>
                    <span ref={peakValueRef}>1,000</span>
                </div>
            </div>

            <canvas
                ref={canvasRef}
                style={{ display: 'block', width: '100%', height: '100%' }}
            />
        </div>
    );
};