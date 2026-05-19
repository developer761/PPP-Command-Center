type Props = {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
};

export default function PageHeader({ title, subtitle, actions }: Props) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4 mb-6 sm:mb-8">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 sm:mt-1.5 text-xs sm:text-sm text-ppp-charcoal-500">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 -mx-1 sm:mx-0 overflow-x-auto sm:overflow-visible scrollbar-thin pb-1 sm:pb-0">
          {actions}
        </div>
      )}
    </div>
  );
}
