import { Router } from 'express'
import { analyze, getVideoInfo } from '../controllers/analyze.controller.js'

const router = Router()

// Video metadata for the popup (called before the user clicks "Analyze Comments").
router.get('/video', getVideoInfo)

// Main endpoint: analyse up to 500 comments and return the community verdict.
router.post('/analyze', analyze)

export default router
