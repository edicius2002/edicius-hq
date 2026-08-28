import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
afterEach(()=>vi.unstubAllGlobals());
it('separates captured posts and replies with metrics and links', async()=>{ vi.stubGlobal('fetch',vi.fn(async()=>Response.json({handle:'thsottiaux',tweets:[{id:'1',date:'2026-01-01',text:'post anon',isReply:false,likeCount:2,retweetCount:3,replyCount:4,url:'https://x.com/a/1'},{id:'2',date:'2026-01-02',text:'reply anon',isReply:true,likeCount:5,retweetCount:6,replyCount:7,url:'https://x.com/a/2'}]}))); render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><DashboardPage/></QueryClientProvider>); expect(await screen.findByText('post anon')).toBeInTheDocument(); expect(screen.getByText('reply anon')).toBeInTheDocument(); expect(screen.getByText(/♥ 2/)).toBeInTheDocument(); expect(screen.getAllByRole('link',{name:'Open on X'})).toHaveLength(2); });
