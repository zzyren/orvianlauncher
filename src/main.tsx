import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import TrayMenu from './ui/TrayMenu'
import './ui/styles.css'

const root = createRoot(document.getElementById('root')!)

if (window.location.hash === '#tray') {
  document.documentElement.classList.add('tray-mode')
  document.body.classList.add('tray-mode')
  root.render(<React.StrictMode><TrayMenu /></React.StrictMode>)
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>)
}
