import React, { useEffect, useRef } from 'react';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Filler
);

interface MonthlyPoint {
  month: string;
  sales: number;
  orders: number;
  collections: number;
}

export const SalesPerformanceChart: React.FC<{ data: MonthlyPoint[]; currency: string }> = ({ data, currency }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: data.map((d) => d.month),
        datasets: [
          {
            label: `Order Sales (${currency})`,
            data: data.map((d) => d.sales),
            borderColor: '#0F766E',
            backgroundColor: 'rgba(15, 118, 110, 0.12)',
            tension: 0.3,
            fill: true,
            borderWidth: 2,
          },
          {
            label: `Payments Collected (${currency})`,
            data: data.map((d) => d.collections),
            borderColor: '#0F172A',
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            tension: 0.3,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#F1F5F9' } },
          x: { grid: { display: false } },
        },
      },
    });
    return () => chart.destroy();
  }, [data, currency]);

  return <canvas ref={canvasRef} />;
};

export const OrderStatusChart: React.FC<{ statusCounts: Record<string, number> }> = ({ statusCounts }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const labels = ['Pending', 'In Progress', 'Completed', 'Ready for Collection', 'Collected', 'Cancelled'];
    const values = labels.map((l) => statusCounts[l] || 0);
    const hasData = values.some((v) => v > 0);

    const chart = new Chart(canvasRef.current, {
      type: 'doughnut',
      data: {
        labels: hasData ? labels : ['No Orders Yet'],
        datasets: [
          {
            data: hasData ? values : [1],
            backgroundColor: hasData
              ? ['#D97706', '#0284C7', '#0F766E', '#16A34A', '#334155', '#DC2626']
              : ['#E2E8F0'],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '66%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        },
      },
    });
    return () => chart.destroy();
  }, [statusCounts]);

  return <canvas ref={canvasRef} />;
};

export const MonthlyPerformanceChart: React.FC<{ data: MonthlyPoint[] }> = ({ data }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: data.map((d) => d.month),
        datasets: [
          {
            label: 'Tailoring Orders Created',
            data: data.map((d) => d.orders),
            backgroundColor: '#0F172A',
            borderRadius: 4,
            barThickness: 24,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: '#F1F5F9' } },
          x: { grid: { display: false } },
        },
      },
    });
    return () => chart.destroy();
  }, [data]);

  return <canvas ref={canvasRef} />;
};
