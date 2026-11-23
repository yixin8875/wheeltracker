import { SettingsIcon, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/native-select';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import type { Account } from '@/types';

export type NavItem = { id: string; label: string; icon: LucideIcon };
export type NavGroup = { id: string; title: string; items: NavItem[] };

export function AppSidebar({
  navigation,
  page,
  onNavigate,
  reminderCount,
  overdueReminders,
  desktop,
  accounts,
  accountId,
  currentAccount,
  busy,
  onSwitchAccount,
}: {
  navigation: NavGroup[];
  page: string;
  onNavigate: (page: string) => void;
  reminderCount: number;
  overdueReminders: number;
  desktop: boolean;
  accounts: Account[];
  accountId: string;
  currentAccount: Account | null;
  busy: boolean;
  onSwitchAccount: (id: string) => void;
}) {
  const { setOpenMobile } = useSidebar();
  const go = (id: string) => {
    onNavigate(id);
    setOpenMobile(false);
  };
  const items = accounts.map(account => ({ value: account.id, label: account.name }));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img src="/wheel-icon.png" alt="" width={32} height={32} className="size-8 shrink-0 rounded-lg border" />
          <div className="grid min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="truncate font-heading text-sm font-semibold">Wheel Tracker</span>
            <span className="truncate text-muted-foreground text-xs">车轮策略成本账本</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        <nav aria-label="主导航" className="flex flex-col gap-2 py-1">
          {navigation.map(group => (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map(item => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={page === item.id}
                        onClick={() => go(item.id)}
                        tooltip={item.label}
                        title={item.id === 'expiry' && reminderCount > 0 ? `${reminderCount} 个到期提醒` : undefined}
                        aria-current={page === item.id ? 'page' : undefined}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                        {item.id === 'expiry' && reminderCount > 0 ? (
                          <SidebarMenuBadge aria-hidden="true" className={overdueReminders ? 'text-destructive-foreground font-semibold' : undefined}>
                            <span className="nav-badge">{reminderCount}</span>
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-3">
        <div className="grid gap-2 group-data-[collapsible=icon]:hidden">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={desktop ? 'size-1.5 rounded-full bg-success' : 'size-1.5 rounded-full bg-warning'} />
            {desktop ? '本地账本' : '浏览器预览'}
          </div>
          <div className="grid gap-1">
            <span className="text-muted-foreground text-xs">账户</span>
            <NativeSelect
              aria-label="切换账户"
              value={accountId}
              disabled={!desktop || busy || !accounts.length}
              onChange={event => onSwitchAccount(event.target.value)}
            >
              {items.map(item => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </NativeSelect>
          </div>
          <p className="text-muted-foreground text-xs">
            {currentAccount?.currency ?? 'USD'} · {accounts.length ? `共 ${accounts.length} 个可用账户` : '美元 USD'}
          </p>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={page === 'settings'} onClick={() => go('settings')} tooltip="设置">
              <SettingsIcon />
              <span>设置</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="hidden group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
          <Badge variant="outline" size="sm" className="num">
            {currentAccount?.currency ?? 'USD'}
          </Badge>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
