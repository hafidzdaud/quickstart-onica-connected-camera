import { ipcMain } from 'electron';
//const url = require('url');
const request = require('request-promise-native')

import { DiscoveryService } from './discoveryService';

/**
 * Provisioning service in main process
 */
export class ProvisioningService {

  discoveryService: DiscoveryService;

  constructor() {
    this.discoveryService = new DiscoveryService()
  }

  registerMainProcessIPC() {
    ipcMain.on('check-stack-endpoint-request', this.checkStackEndpoint.bind(this))
    ipcMain.on('provision-camera-request', this.provisionCamera.bind(this))
  }

  /**
   * @param args {stackEndpoint, provisioningKey}.
   */
  checkStackEndpoint(event, args) {
    console.log("main process received stack endpoint requests.")
    console.log(args)

    const url = (args.stackEndpoint || '').trim() + "/stack_availability"
    const Authorization = (args.provisioningKey || '').trim()
    console.log(url)
    request({
      url,
      method: 'get',
      headers: {
        Authorization
      }
    }).then(result => {
      console.log("Stack available.")
      console.log(result)
      event.sender.send('check-stack-endpoint-response', {})
    }).catch(err => {
      //403 response means invalid provisioning key.
      //No response means stack url is incorrect or inaccessible.
      console.log("Stack not available")
      console.log(err)
      console.log(err.name)
      console.log(err.statusCode)
      console.log(err.message)
      const error = err.statusCode == 403 ? 'provisioningKey' : 'stackEndpoint'
      event.sender.send('check-stack-endpoint-response', {error})
    })
  }

  /**
   * @param args {stackEndpoint, provisioningKey, camera}.
   * @returns {camera, error, errorMessage}
   */
  provisionCamera(event, args) {
    console.log("main process received provisiong camera request.")
    console.log(args)

    this.provisionCloudStep(event, args)
      .then(thing => this.provisionCameraStep(event, args, thing))
      .then(() => {
        console.log("Provisioning success.")
        event.sender.send('provision-camera-response', {camera: args.camera})
      })
      .catch(err => {
        console.log("Provisioning error.")
        args.camera.workflowError = true
        args.camera.workflowErrorMessage = `Provisioning failure in ${err.step} step: ${err.message}`
        event.sender.send('provision-camera-response', {camera: args.camera})
      })
  }


  provisionCloudStep(event, args) {
    console.log("cloud step")
    const url = (args.stackEndpoint || '').trim() + "/provision"
    const Authorization = (args.provisioningKey || '').trim()
    const id = args.camera.urn
    console.log(url)
    return request({
      url,
      method: 'post',
      headers: {
        Authorization
      },
      body: JSON.stringify({id})
    }).then(result => {
      console.log("Provisioning success in cloud step!")
      console.log(result)
      const thing = JSON.parse(result)
      return thing
    }).catch(err => {
      console.log("Provisioning failure in cloud step!")
      console.log(err)
      console.log(err.name)
      console.log(err.statusCode)
      console.log(err.message)
      err.step = "cloud"
      throw err
    })
  }

  provisionCameraStep(event, args, thing) {
    console.log("camera step")

    //camera pairing url
    const url = `${args.camera.cameraApiScheme}://${args.camera.ip}/provisioning/pair`
    console.log(url)

    //camera Basic auth
    let Authorization
    if (args.camera.cameraApiUsername.length > 0 || args.camera.cameraApiPassword.length > 0) {
      console.log("Including camera authentication.")
      Authorization = "Basic " + Buffer.from(`${args.camera.cameraApiUsername}:${args.camera.cameraApiPassword}`).toString('base64')
      console.log(Authorization)
    } else {
      console.log("Skipping camera authentication.")
    }

    //provisioning docs mistakenly specified 'Authentication' header, so provide both
    const Authentication = Authorization

    //provide provisioned thing data via camera pairing api
    return request({
      url,
      method: 'put',
      headers: {
        Authorization,
        Authentication
      },
      body: JSON.stringify(thing)
    }).then(result => {
      console.log("Provisioning success in camera step!")
      console.log(result)

      //assume PAIRED status after successful api call, and check camera status api.
      args.camera.status = 'PAIRED'
      return this.discoveryService.updateCameraStatus({camera: args.camera})
    }).catch(err => {
      console.log("Provisioning failure in camera step!")
      console.log(err)
      console.log(err.name)
      console.log(err.statusCode)
      console.log(err.message)
      err.step = "camera"

      //if we can't connect, it likely means ip address or camera api scheme (http/https) is incorrect.
      if (err.name == 'RequestError' && err.status == undefined) {
        err.message = "Unable to provision camera: unable to connect. Check camera ip address or provisioning api scheme (http/https)."
      }

      //if we get an auth error, it likely means camera api username/password is incorrect
      if (err.statusCode == 401 || err.statusCode == 403) {
        err.message = "Unable to provision camera: received authentication error from camera. Check camera api username/password."
      }

      throw err
    })
  }
}
