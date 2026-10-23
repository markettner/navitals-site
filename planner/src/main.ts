import { mount } from 'svelte';
import App from './App.svelte';
import './planner.css';
// The site's icon and logo, bundled from the site rather than copied (index.html can't reach them in dev).
import icon from '../../icon.png';
import logo from '../../logo.svg';

document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href = icon;
mount(App, { target: document.body, props: { logo } });
