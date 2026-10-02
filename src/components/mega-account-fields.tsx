"use client"

import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

interface AccountFields {
    id?: string;
    username?: string;
    password?: string;
    isActive?: boolean;
}

export function MegaAccountFields({ account, onChange }: {
    account: AccountFields;
    onChange: (fields: Omit<AccountFields, 'id'>) => void;
}) {
    const id = useId();
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

    const update = (fields: Omit<AccountFields, 'id'>) => {
        setResult(null);
        onChange(fields);
    };
    const testAccount = async () => {
        setTesting(true);
        setResult(null);
        try {
            const response = await fetch('/api/admin/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'mega', config: {
                    id: account.id, username: account.username, password: account.password,
                } }),
            });
            const data = await response.json();
            setResult({ success: response.ok && data.success === true, message: data.message || 'MEGA account test failed.' });
        } catch {
            setResult({ success: false, message: 'Could not test the MEGA account. Try again later.' });
        } finally {
            setTesting(false);
        }
    };

    return <>
        <div className="flex items-center gap-2">
            <Switch id={`${id}-active`} checked={account.isActive !== false} disabled={testing}
                onCheckedChange={isActive => update({ isActive })} />
            <Label htmlFor={`${id}-active`}>Use MEGA account</Label>
        </div>
        <div className="grid gap-2">
            <Label htmlFor={`${id}-email`}>MEGA Email</Label>
            <Input id={`${id}-email`} type="email" autoComplete="username" value={account.username || ''} disabled={testing}
                onChange={event => update({ username: event.target.value })} placeholder="email@example.com" />
        </div>
        <div className="grid gap-2">
            <Label htmlFor={`${id}-password`}>MEGA Password</Label>
            <Input id={`${id}-password`} type="password" autoComplete="current-password" value={account.password || ''} disabled={testing}
                onChange={event => update({ password: event.target.value })} />
        </div>
        <p className="text-xs text-muted-foreground">Downloads use this account&apos;s transfer allowance. Clear both fields for anonymous downloads. Accounts requiring two-factor authentication currently fall back to anonymous downloads.</p>
        <Button type="button" variant="outline" onClick={testAccount} disabled={testing || !account.username?.trim() || !account.password}>
            {testing ? 'Testing…' : 'Test Account'}
        </Button>
        {result && <p role="status" className={`text-sm ${result.success ? 'text-green-600' : 'text-destructive'}`}>{result.message}</p>}
    </>;
}
