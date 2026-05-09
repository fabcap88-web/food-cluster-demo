import './globals.css';
export const metadata = { title: 'Merchant Dashboard', description: 'Food Cluster MVP' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="it"><body>{children}</body></html>;
}
