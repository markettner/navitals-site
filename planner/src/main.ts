import { mount } from 'svelte';
import App from './App.svelte';
import './planner.css';
// The site's icon, bundled from the site rather than copied (index.html can't reach it in dev).
import icon from '../../icon.png';

document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = icon;
mount(App, { target: document.body, props: { icon } });
