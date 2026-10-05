import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import Tray from './ui/views/Tray'
import { ToastProvider } from './ui/components/Toast'
import './ui/styles/tokens.css'
import './ui/styles/base.css'
import './ui/styles/components.css'
import './ui/styles/views.css'

const root = createRoot(document.getElementById('root')!)

if (window.location.hash === '#tray') {
  document.documentElement.classList.add('tray-mode')
  document.body.classList.add('tray-mode')
  root.render(<React.StrictMode><ToastProvider><Tray /></ToastProvider></React.StrictMode>)
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>)
}
