import React, { Component } from 'react';
import { Link } from 'react-router-dom';
import api from './Api';
import { percentage } from './utils';

export default class Funnels extends Component {
    constructor(props) {
        super(props)
    
        this.state = {
             
        }
        this.fetchFunnels.call(this);
    }
    fetchFunnels() {
        let sort = (funnels) => {
            funnels.sort((a, b) => (b.steps[0] ? b.steps[0].people.length: 0) - (a.steps[0] ? a.steps[0].people.length : 0))
            return funnels
        }
        api.get('api/funnel').then((funnels) => { 
            this.setState({funnels: sort(funnels.results)})
        })
    }
    render() {
        return <div>
            <Link to={'/new-funnel'} className='btn btn-outline-success float-right'><i className='fi flaticon-add'/>&nbsp;&nbsp;New funnel</Link>
            <h1>Funnels</h1>
            <table className='table'>
                <tbody>
                    <tr><th>Funnel name</th><th>Completion rate</th><th>Users top of funnel</th><th>Users bottom of funnel</th><th>Steps in funnel</th><th>Actions</th></tr>
                    {this.state.funnels && this.state.funnels.map((funnel) => <tr key={funnel.id}>
                        <td><Link to={'/funnel/' + funnel.id}>{funnel.name}</Link></td>
                        <td>{funnel.steps[0] && percentage(funnel.steps[funnel.steps.length -1].people.length / funnel.steps[0].people.length)}</td>
                        <td>{funnel.steps[0] && funnel.steps[0].people.length}</td>
                        <td>{funnel.steps[funnel.steps.length - 1] && funnel.steps[funnel.steps.length -1].people.length}</td>
                        <td>{funnel.steps[0] && funnel.steps[0].people.length}</td>
                        <td><Link to={'/funnel/' + funnel.id + '/edit'}><i className='fi flaticon-edit' /></Link></td>
                    </tr>)}
                </tbody>
            </table>
        </div>
    }
}