import { OpsStackView } from './ops-stack-view';

export const metadata = {
  title: 'Stack · Fire Enrich operations',
};

export const dynamic = 'force-dynamic';

export default function OpsStackPage() {
  return <OpsStackView />;
}
